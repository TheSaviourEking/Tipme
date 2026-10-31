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
export { MAIL_TYPES, renderMail } from './templates/registry.js';
export {
  MAIL_SENDERS,
  senderAddress,
  type MailSender,
} from './templates/define.js';
export { isPretendRecipient, resolveMailProvider } from './routing.js';
export {
  createZeptoMailProvider,
  type ZeptoMailConfig,
} from './zeptomail/provider.js';
export { createSesProvider, type SesConfig } from './ses/provider.js';
export {
  checkMailSettings,
  configuredMailProviderNames,
  configuredMailProviders,
  mailSettingsShape,
  type MailSettings,
} from './settings.js';
