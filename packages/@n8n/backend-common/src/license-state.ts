import { UNLIMITED_LICENSE_QUOTA, type BooleanLicenseFeature } from '@n8n/constants';
import { Service } from '@n8n/di';
import { UnexpectedError } from 'n8n-workflow';

import type { FeatureReturnType, LicenseProvider } from './types';

class ProviderNotSetError extends UnexpectedError {
	constructor() {
		super('Cannot query license state because license provider has not been set');
	}
}

@Service()
export class LicenseState {
	licenseProvider: LicenseProvider | null = null;

	setLicenseProvider(provider: LicenseProvider) {
		this.licenseProvider = provider;
	}

	private assertProvider(): asserts this is { licenseProvider: LicenseProvider } {
		if (!this.licenseProvider) throw new ProviderNotSetError();
	}

	// --------------------
	//     core queries
	// --------------------

	isLicensed(feature: BooleanLicenseFeature) {
		this.assertProvider();

		return this.licenseProvider.isLicensed(feature);
	}

	getValue<T extends keyof FeatureReturnType>(feature: T): FeatureReturnType[T] {
		this.assertProvider();

		return this.licenseProvider.getValue(feature);
	}

	// --------------------
	//      booleans
	// --------------------

	isSharingLicensed() {
		// return this.isLicensed('feat:sharing');
		return true;
	}

	isLogStreamingLicensed() {
		// return this.isLicensed('feat:logStreaming');
		return true;
	}

	isLdapLicensed() {
		// return this.isLicensed('feat:ldap');
		return true;
	}

	isSamlLicensed() {
		// return this.isLicensed('feat:saml');
		return true;
	}

	isApiKeyScopesLicensed() {
		// return this.isLicensed('feat:apiKeyScopes');
		return true;
	}

	isAiAssistantLicensed() {
		// return this.isLicensed('feat:aiAssistant');
		return true;
	}

	isAskAiLicensed() {
		return this.isLicensed('feat:askAi');
	}

	isAiCreditsLicensed() {
		return this.isLicensed('feat:aiCredits');
	}

	isAdvancedExecutionFiltersLicensed() {
		// return this.isLicensed('feat:advancedExecutionFilters');
		return true;
	}

	isAdvancedPermissionsLicensed() {
		// return this.isLicensed('feat:advancedPermissions');
		return true;
	}

	isDebugInEditorLicensed() {
		// return this.isLicensed('feat:debugInEditor');
		return true;
	}

	isBinaryDataS3Licensed() {
		// return this.isLicensed('feat:binaryDataS3');
		return true;
	}

	isMultiMainLicensed() {
		// return this.isLicensed('feat:multipleMainInstances');
		return true;
	}

	isVariablesLicensed() {
		// return this.isLicensed('feat:variables');
		return true;
	}

	isSourceControlLicensed() {
		// return this.isLicensed('feat:sourceControl');
		return true;
	}

	isExternalSecretsLicensed() {
		// return this.isLicensed('feat:externalSecrets');
		return true;
	}

	isWorkflowHistoryLicensed() {
		// return this.isLicensed('feat:workflowHistory');
		return true;
	}

	isAPIDisabled() {
		// return this.isLicensed('feat:apiDisabled');
		return false;
	}

	isWorkerViewLicensed() {
		// return this.isLicensed('feat:workerView');
		return true;
	}

	isProjectRoleAdminLicensed() {
		// return this.isLicensed('feat:projectRole:admin');
		return true;
	}

	isProjectRoleEditorLicensed() {
		// return this.isLicensed('feat:projectRole:editor');
		return true;
	}

	isProjectRoleViewerLicensed() {
		// return this.isLicensed('feat:projectRole:viewer');
		return true;
	}

	isCustomNpmRegistryLicensed() {
		// return this.isLicensed('feat:communityNodes:customRegistry');
		return true;
	}

	isFoldersLicensed() {
		// return this.isLicensed('feat:folders');
		return true;
	}

	isInsightsSummaryLicensed() {
		// return this.isLicensed('feat:insights:viewSummary');
		return true;
	}

	isInsightsDashboardLicensed() {
		// return this.isLicensed('feat:insights:viewDashboard');
		return true;
	}

	isInsightsHourlyDataLicensed() {
		// return this.isLicensed('feat:insights:viewHourlyData');
		return true;
	}

	// --------------------
	//      integers
	// --------------------

	getMaxUsers() {
		// return this.getValue('quota:users') ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxActiveWorkflows() {
		// return this.getValue('quota:activeWorkflows') ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxVariables() {
		// return this.getValue('quota:maxVariables') ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getMaxAiCredits() {
		return this.getValue('quota:aiCredits') ?? 0;
	}

	getWorkflowHistoryPruneQuota() {
		// return this.getValue('quota:workflowHistoryPrune') ?? UNLIMITED_LICENSE_QUOTA;
		return UNLIMITED_LICENSE_QUOTA;
	}

	getInsightsMaxHistory() {
		return this.getValue('quota:insights:maxHistoryDays') ?? 7;
		return 7;
	}

	getInsightsRetentionMaxAge() {
		// return this.getValue('quota:insights:retention:maxAgeDays') ?? 180;
		return 180;
	}

	getInsightsRetentionPruneInterval() {
		// return this.getValue('quota:insights:retention:pruneIntervalDays') ?? 24;
		return 24;
	}

	getMaxTeamProjects() {
		// return this.getValue('quota:maxTeamProjects') ?? 0;
		return UNLIMITED_LICENSE_QUOTA;
	}
}
