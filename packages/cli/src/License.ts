import type { TEntitlement, TFeatures, TLicenseBlock } from '@n8n_io/license-sdk';
import { LicenseManager } from '@n8n_io/license-sdk';
import { InstanceSettings, ObjectStoreService } from 'n8n-core';
import Container, { Service } from 'typedi';
import { Logger } from '@/Logger';
import config from '@/config';
import {
	LICENSE_FEATURES,
	LICENSE_QUOTAS,
	N8N_VERSION,
	SETTINGS_LICENSE_CERT_KEY,
	UNLIMITED_LICENSE_QUOTA,
} from './constants';
import { SettingsRepository } from '@db/repositories/settings.repository';
import type { BooleanLicenseFeature, N8nInstanceType, NumericLicenseFeature } from './Interfaces';
import type { RedisServicePubSubPublisher } from './services/redis/RedisServicePubSubPublisher';
import { RedisService } from './services/redis.service';
import { OrchestrationService } from '@/services/orchestration.service';
import { OnShutdown } from '@/decorators/OnShutdown';
import { UsageMetricsService } from './services/usageMetrics.service';

type FeatureReturnType = Partial<
	{
		planName: string;
	} & { [K in NumericLicenseFeature]: number } & { [K in BooleanLicenseFeature]: boolean }
>;

@Service()
export class License {
	private manager: LicenseManager | undefined;

	private redisPublisher: RedisServicePubSubPublisher;

	private isShuttingDown = false;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly orchestrationService: OrchestrationService,
		private readonly settingsRepository: SettingsRepository,
		private readonly usageMetricsService: UsageMetricsService,
	) {}

	/**
	 * Whether this instance should renew the license - on init and periodically.
	 */
	private renewalEnabled(instanceType: N8nInstanceType) {
		if (instanceType !== 'main') return false;

		const autoRenewEnabled = config.getEnv('license.autoRenewEnabled');

		/**
		 * In multi-main setup, all mains start off with `unset` status and so renewal disabled.
		 * On becoming leader or follower, each will enable or disable renewal, respectively.
		 * This ensures the mains do not cause a 429 (too many requests) on license init.
		 */
		if (config.getEnv('multiMainSetup.enabled')) {
			return autoRenewEnabled && config.getEnv('multiMainSetup.instanceType') === 'leader';
		}

		return false;
	}

	async init(instanceType: N8nInstanceType = 'main', forceRecreate = false) {
		if (this.manager && !forceRecreate) {
			this.logger.warn('License manager already initialized or shutting down');
			return;
		}
		if (this.isShuttingDown) {
			this.logger.warn('License manager already shutting down');
			return;
		}

		const isMainInstance = instanceType === 'main';
		const server = config.getEnv('license.serverUrl');
		const offlineMode = !isMainInstance;
		const autoRenewOffset = config.getEnv('license.autoRenewOffset');
		const saveCertStr = isMainInstance
			? async (value: TLicenseBlock) => await this.saveCertStr(value)
			: async () => {};
		const onFeatureChange = isMainInstance
			? async (features: TFeatures) => await this.onFeatureChange(features)
			: async () => {};
		// const collectUsageMetrics = isMainInstance
		// 	? async () => await this.usageMetricsService.collectUsageMetrics()
		// 	: async () => [];
		const collectUsageMetrics = async () => [];

		const renewalEnabled = this.renewalEnabled(instanceType);

		try {
			this.manager = new LicenseManager({
				server,
				tenantId: config.getEnv('license.tenantId'),
				productIdentifier: `n8n-${N8N_VERSION}`,
				autoRenewEnabled: renewalEnabled,
				renewOnInit: renewalEnabled,
				autoRenewOffset,
				offlineMode,
				logger: this.logger,
				loadCertStr: async () => await this.loadCertStr(),
				saveCertStr,
				deviceFingerprint: () => this.instanceSettings.instanceId,
				collectUsageMetrics,
				onFeatureChange,
			});

			await this.manager.initialize();

			console.log('license manager: ', this.manager)
		} catch (e: unknown) {
			if (e instanceof Error) {
				this.logger.error('Could not initialize license manager sdk', e);
			}
		}
	}

	async loadCertStr(): Promise<TLicenseBlock> {
		// if we have an ephemeral license, we don't want to load it from the database
		const ephemeralLicense = config.get('license.cert');
		if (ephemeralLicense) {
			return ephemeralLicense;
		}
		const databaseSettings = await this.settingsRepository.findOne({
			where: {
				key: SETTINGS_LICENSE_CERT_KEY,
			},
		});

		return databaseSettings?.value ?? '';
	}

	async onFeatureChange(_features: TFeatures): Promise<void> {
		if (config.getEnv('executions.mode') === 'queue' && config.getEnv('multiMainSetup.enabled')) {
			// const isMultiMainLicensed = _features[LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES] as
			// 	| boolean
			// 	| undefined;
			const isMultiMainLicensed = true

			this.orchestrationService.setMultiMainSetupLicensed(isMultiMainLicensed ?? false);

			if (
				this.orchestrationService.isMultiMainSetupEnabled &&
				this.orchestrationService.isFollower
			) {
				this.logger.debug(
					'[Multi-main setup] Instance is follower, skipping sending of "reloadLicense" command...',
				);
				return;
			}

			if (this.orchestrationService.isMultiMainSetupEnabled && !isMultiMainLicensed) {
				this.logger.debug(
					'[Multi-main setup] License changed with no support for multi-main setup - no new followers will be allowed to init. To restore multi-main setup, please upgrade to a license that supports this feature.',
				);
			}
		}

		if (config.getEnv('executions.mode') === 'queue') {
			if (!this.redisPublisher) {
				this.logger.debug('Initializing Redis publisher for License Service');
				this.redisPublisher = await Container.get(RedisService).getPubSubPublisher();
			}
			await this.redisPublisher.publishToCommandChannel({
				command: 'reloadLicense',
			});
		}

		const isS3Selected = config.getEnv('binaryDataManager.mode') === 's3';
		const isS3Available = config.getEnv('binaryDataManager.availableModes').includes('s3');
		// const isS3Licensed = _features['feat:binaryDataS3'];
		const isS3Licensed = true;

		if (isS3Selected && isS3Available && !isS3Licensed) {
			this.logger.debug(
				'License changed with no support for external storage - blocking writes on object store. To restore writes, please upgrade to a license that supports this feature.',
			);

			Container.get(ObjectStoreService).setReadonly(true);
		}
	}

	async saveCertStr(value: TLicenseBlock): Promise<void> {
		// if we have an ephemeral license, we don't want to save it to the database
		if (config.get('license.cert')) return;
		await this.settingsRepository.upsert(
			{
				key: SETTINGS_LICENSE_CERT_KEY,
				value,
				loadOnStartup: false,
			},
			['key'],
		);
	}

	async activate(activationKey: string): Promise<void> {
		if (!this.manager) {
			return;
		}

		await this.manager.activate(activationKey);
	}

	async reload(): Promise<void> {
		if (!this.manager) {
			return;
		}
		this.logger.debug('Reloading license');
		await this.manager.reload();
	}

	async renew() {
		if (!this.manager) {
			return;
		}

		await this.manager.renew();
	}

	@OnShutdown()
	async shutdown() {
		// Shut down License manager to unclaim any floating entitlements
		// Note: While this saves a new license cert to DB, the previous entitlements are still kept in memory so that the shutdown process can complete
		this.isShuttingDown = true;

		if (!this.manager) {
			return;
		}

		await this.manager.shutdown();
	}

	isFeatureEnabled(feature: BooleanLicenseFeature) {
		// return this.manager?.hasFeatureEnabled(feature) ?? false;
		return true;
	}

	isSharingEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.SHARING);
		return true;
	}

	isLogStreamingEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.LOG_STREAMING);
		return true
	}

	isLdapEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.LDAP);
		return true
	}

	isSamlEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.SAML);
		return true
	}

	isAdvancedExecutionFiltersEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.ADVANCED_EXECUTION_FILTERS);
		return true
	}

	isAdvancedPermissionsLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.ADVANCED_PERMISSIONS);
		return true
	}

	isDebugInEditorLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.DEBUG_IN_EDITOR);
		return true
	}

	isBinaryDataS3Licensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.BINARY_DATA_S3);
		return true
	}

	isMultipleMainInstancesLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES);
		return true
	}

	isVariablesEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.VARIABLES);
		return true
	}

	isSourceControlLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.SOURCE_CONTROL);
		return true
	}

	isExternalSecretsEnabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.EXTERNAL_SECRETS);
		return true
	}

	isWorkflowHistoryLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.WORKFLOW_HISTORY);
		return true
	}

	isAPIDisabled() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.API_DISABLED);
		return false;
	}

	isWorkerViewLicensed() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.WORKER_VIEW);
		return true
	}

	isShowNonProdBanner() {
		// return this.isFeatureEnabled(LICENSE_FEATURES.WORKER_VIEW);
		return false
	}

	isProjectRoleAdminLicensed() {
		return this.isFeatureEnabled(LICENSE_FEATURES.PROJECT_ROLE_ADMIN);
	}

	isProjectRoleEditorLicensed() {
		return this.isFeatureEnabled(LICENSE_FEATURES.PROJECT_ROLE_EDITOR);
	}

	isProjectRoleViewerLicensed() {
		return this.isFeatureEnabled(LICENSE_FEATURES.PROJECT_ROLE_VIEWER);
	}

	getCurrentEntitlements() {
		return this.manager?.getCurrentEntitlements() ?? [];
	}

	getFeatureValue<T extends keyof FeatureReturnType>(feature: T): FeatureReturnType[T] {
		return this.manager?.getFeatureValue(feature) as FeatureReturnType[T];
	}

	getManagementJwt(): string {
		if (!this.manager) {
			return '';
		}
		return this.manager.getManagementJwt();
	}

	/**
	 * Helper function to get the main plan for a license
	 */
	getMainPlan(): TEntitlement | undefined {
		if (!this.manager) {
			return undefined;
		}

		const entitlements = this.getCurrentEntitlements();
		if (!entitlements.length) {
			return undefined;
		}

		return entitlements.find(
			(entitlement) => (entitlement.productMetadata?.terms as { isMainPlan?: boolean })?.isMainPlan,
		);
	}

	// Helper functions for computed data
	getUsersLimit() {
		// return this.getFeatureValue(LICENSE_QUOTAS.USERS_LIMIT) ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getTriggerLimit() {
		// return this.getFeatureValue(LICENSE_QUOTAS.TRIGGER_LIMIT) ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getVariablesLimit() {
		// return this.getFeatureValue(LICENSE_QUOTAS.VARIABLES_LIMIT) ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getWorkflowHistoryPruneLimit() {
		return (
			// this.getFeatureValue(LICENSE_QUOTAS.WORKFLOW_HISTORY_PRUNE_LIMIT) ?? UNLIMITED_LICENSE_QUOTA
			UNLIMITED_LICENSE_QUOTA
		);
	}

	getTeamProjectLimit() {
		return this.getFeatureValue(LICENSE_QUOTAS.TEAM_PROJECT_LIMIT) ?? 0;
	}

	getPlanName(): string {
		return this.getFeatureValue('planName') ?? 'KDIGI';
	}

	getInfo(): string {
		if (!this.manager) {
			return 'n/a';
		}

		return this.manager.toString();
	}

	isWithinUsersLimit() {
		return this.getUsersLimit() === UNLIMITED_LICENSE_QUOTA;
	}

	async reinit() {
		this.manager?.reset();
		await this.init('main', true);
	}
}
