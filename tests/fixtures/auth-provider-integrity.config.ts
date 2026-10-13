import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '../e2e',
    testMatch: 'auth-provider-integrity.spec.ts',
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 7_000 },
    reporter: 'list',
    outputDir: 'C:/Users/elekt/AppData/Local/Temp/opencode/auth-provider-integrity-artifacts',
    use: { headless: true, launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } }
});
