# @codexydsh/deepseek

DeepSeek Messages adapter.

Installed through the product bundles and profiles; DSH remains the unmodified platform dependency.

Exports: `.` (API-key route) and `./account` (the exact `deepseek-account` route).

The account route uses only the public account service's destination-authorized token; it does not fall back to an API key. HTTP, SSE and Files authentication/quota errors retain account-specific behavior, and a rejected request invalidates only the token it used. Tokens never enter request headers stored in session history.

At startup, the account plugin reads protocol fields from the disabled, exact original `llm-deepseek-account` root row in the same composition. Explicit product fields override this read-only snapshot; credentials and unknown fields are excluded, and the original YAML and expressions remain untouched. Changing the old row requires a restart. Effective inherited values are used by requests and model discovery; the product settings schema still shows its own defaults until a field is explicitly configured there. Nested/isolated legacy rows are not inherited.

Build and focused behavior tests are run from the repository root. See [product setup](../../README.md) and [component validation](../../README.md#组件清单与验证范围).
