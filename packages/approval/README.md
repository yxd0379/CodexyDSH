# Codexy Approval

`codexyApproval` owns action decisions, exact-action and command-prefix grants for the current Session, and human or automatic reviewers. It provides the stock `approval` capability through an explicit adapter so existing DSH tools use the same request and durable audit.

Requests use `codexy-approval/request` and `codexy-approval/auto-review`. Missing answerers, invalid answers and reviewer errors grant no access. Approval facts are stored as required Codexy Session events; the product runtime projects them for restoration and UI display. Permission changes withdraw pending requests and invalidate reusable grants.
