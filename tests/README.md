# End-to-end test

Loads the extension into a real Chromium via Playwright and checks the popup tools, page analysis,
word hover and Shift sentence mode.

    npm install playwright@1.64.1
    $env:EXT_DIR = "<path to this folder>"
    $env:CHROME_PATH = "<path to a chromium/chrome.exe>"   # optional
    $env:TEST_KEY = "<your API key>"
    $env:TEST_EP = "https://<host>/v1"
    $env:TEST_MODEL = "<model name>"
    node tests/e2e.js

Secrets are read only from environment variables and never written to disk.
