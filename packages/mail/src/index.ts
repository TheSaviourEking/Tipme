export * from './provider.js';
export * from './errors.js';
export { createMockMailProvider } from './mock/provider.js';
export {
  defineMailType,
  mailLink,
  MAIL_CATEGORIES,
  type MailCategory,
  type MailContext,
  type MailPreference,
  type MailType,
  type RenderedMail,
} from './templates/define.js';
export { escapeHtml } from './templates/escape.js';
export type { Block, Letter, Span } from './templates/layout.js';
export {
  ANNOUNCEMENT_LIMITS,
  announcementBlocks,
  announcementSchema,
  type AnnouncementData,
} from './templates/types/announcement.js';
export { MAIL_TYPES, renderMail } from './templates/registry.js';
export {
  MAIL_SENDERS,
  senderAddress,
  type MailSender,
} from './templates/define.js';
export {
  isPretendRecipient,
  mailFailoverGroup,
  mailProviderChain,
  resolveMailProvider,
} from './routing.js';
export {
  createMailHealth,
  liveMailProvider,
  mailHealthView,
  memoryMailHealthStore,
  redisMailHealthStore,
  type MailHealth,
  type MailHealthChange,
  type MailHealthChangeEvent,
  type MailHealthRecord,
  type MailHealthRedis,
  type MailHealthSettings,
  type MailHealthStore,
  type MailHealthView,
  type MailTripKind,
} from './health.js';
export { createBrevoProvider, type BrevoConfig } from './brevo/provider.js';
export {
  createZeptoMailProvider,
  type ZeptoMailConfig,
} from './zeptomail/provider.js';
export { createSesProvider, type SesConfig } from './ses/provider.js';
export {
  announcementMailProvider,
  checkMailSettings,
  configuredMailProviderNames,
  configuredMailProviders,
  isProductionMail,
  mailHealthSettings,
  mailSettingsShape,
  type MailSettings,
} from './settings.js';
