import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Tests plant the bundle's own `<script src=...?v=>` tag to exercise
    // the integration-version reader (src/utils/version.ts). happy-dom
    // otherwise tries to GET it off localhost and logs the failure for
    // every run; nothing in this suite wants a script actually fetched
    // or executed, so treat a skipped load as a load.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
