export {
  AIU_PLUGIN_WRAPPER_RELATIVE_PATH,
  getAiuPackageAssetPaths,
  getAiuPackageRoot,
} from "./assets.js";
export {
  aiuCli,
  runAiuCli,
} from "./cli.js";
export {
  AIU_COMMAND_REGISTRY,
  configCommand,
  doctorCommand,
  initCommand,
  migrateCommand,
  pathsCommand,
} from "./command_registry.js";
export {
  AIU_CONFIG_FILENAME,
  AIU_CONFIG_SCHEMA_VERSION,
  AIU_CONTINUATION_MODES,
  AIU_HOST_CAPABILITY_NAMES,
  AIU_HOSTS,
  formatConfigDiagnostics,
  getDefaultAiuConfig,
  loadAiuConfig,
} from "./config.js";
export {
  formatAiuDoctorReport,
  formatAiuPaths,
  getAiuResolvedPaths,
  runAiuDoctor,
} from "./doctor.js";
export {
  AIU_INIT_TOOLS,
  applyAiuInitPlan,
  formatInitPlan,
  getAiuHostCapabilityProfiles,
  planAiuInit,
} from "./init.js";
export {
  formatMigrationPlan,
  planAiuMigration,
} from "./migrate.js";
export type {
  AiuPackageAssetPaths,
} from "./assets.js";
export type {
  AiuConfig,
  AiuConfigDiagnostic,
  AiuConfigLoadResult,
  AiuContinuationMode,
  AiuContinuationPolicy,
  AiuHost,
  AiuHostCapabilityName,
  AiuTrustedStateCommandDescriptor,
} from "./config.js";
export type {
  AiuDoctorCheck,
  AiuDoctorReport,
  AiuHealthStatus,
  AiuHostFilePath,
  AiuHostPathSet,
  AiuInspectionOptions,
  AiuPackageBinPath,
  AiuResolvedPaths,
  AiuTrustedCommandPath,
} from "./doctor.js";
export type {
  AiuHostCapabilityProfile,
  AiuInitFileAction,
  AiuInitFileOperation,
  AiuInitOptions,
  AiuInitPlan,
  AiuInitTool,
} from "./init.js";
export type {
  AiuMigrationFinding,
  AiuMigrationManagedSection,
  AiuMigrationOptions,
  AiuMigrationPlan,
  AiuMigrationStatePreservation,
} from "./migrate.js";
