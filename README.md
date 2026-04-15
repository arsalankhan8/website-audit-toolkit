<!-- Paste that website-audit-test.js code into browser console,
Press enter
then paste this function below and add your website pages url on which you want to run the test  -->

runWebsiteAudit({
  customUrls: [
    "https://example.com/",
    "https://example.com/about",
    "https://example.com/contact"
  ],
  maxDepth: 0 // 👈 important (prevents auto crawling)
});
