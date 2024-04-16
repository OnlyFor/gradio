import { defineConfig } from "@playwright/test";

const base = defineConfig({
	use: {
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		permissions: ["clipboard-read", "clipboard-write", "microphone"],
		bypassCSP: true,
		launchOptions: {
			args: [
				"--disable-web-security",
				"--use-fake-device-for-media-stream",
				"--use-fake-ui-for-media-stream",
				"--use-file-for-fake-audio-capture=../gradio/test_data/test_audio.wav"
			]
		}
	},
	expect: { timeout: 15000 },
	timeout: 30000,
	testMatch: /.*.spec.ts/,
	testDir: "..",
	workers: process.env.CI ? 1 : undefined,
	retries: 3
});

const normal = defineConfig(base, {
	globalSetup: process.env.CUSTOM_TEST ? undefined : "./playwright-setup.js"
});

normal.projects = undefined; // Explicitly unset this field due to https://github.com/microsoft/playwright/issues/28795

const lite = defineConfig(base, {
	webServer: {
		command: "pnpm --filter @gradio/app dev:lite",
		url: "http://localhost:9876/lite.html",
		reuseExistingServer: !process.env.CI
	},
	testMatch: [
		"**/file_component_events.spec.ts",
		"**/chatbot_multimodal.spec.ts",
		"**/kitchen_sink.spec.ts",
		"**/gallery_component_events.spec.ts",
		"**/image_remote_url.spec.ts" // To detect the bugs on Lite fixed in https://github.com/gradio-app/gradio/pull/8011 and https://github.com/gradio-app/gradio/pull/8026
	],
	workers: 1,
	retries: 3
});

lite.projects = undefined; // Explicitly unset this field due to https://github.com/microsoft/playwright/issues/28795

export default !!process.env.GRADIO_E2E_TEST_LITE ? lite : normal;
