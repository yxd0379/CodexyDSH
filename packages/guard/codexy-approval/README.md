# Codexy Approval

`codexyApproval` owns action decisions, exact-action and command-prefix grants for the current Session, and human or automatic reviewers. It provides the stock `approval` capability through an explicit adapter so existing DSH tools use the same request and durable audit.

Human requests, including automatic review's manual fallback, use the native `approval/request` event and unchanged approval UI. That UI currently offers one-shot allow or reject; private action identities and Session-grant fields are not sent through its codec. Automatic review keeps the product `codexy-approval/auto-review` event and its richer review capabilities.

Missing answerers, invalid answers and reviewer errors grant no access. Asked/decided audit facts use native Session events. Private review records and reviewer settings use the plugin storage domain. Permission changes withdraw pending requests and invalidate reusable grants.
