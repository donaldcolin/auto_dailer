// Re-export the native module. On web, it will be resolved to DialerModule.web.ts
// and on native platforms to DialerModule.ts
export { default } from './src/DialerModule';
export * from './src/Dialer.types';
