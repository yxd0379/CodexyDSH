# Codexy token meter

This plugin provides `codexyTokenMeter` and exposes the public DSH `tokenMeter` methods for existing UI consumers. It measures the native tool catalog retained in Codexy request facts and reads retry and compaction records from their durable product carriers. The `tokenUsage`, `contextPressure`, and `contextBreakdown` projections retain the public DSH wire fields.

Set `preferProviderUsage: true` to use matching provider usage even when the local estimate is higher. Successful compaction clears that anchor, so the shortened context is repriced before the next request. The Codexy bundle enables this policy.

`./client` exports the browser-safe projection types and complete-turn usage fold; `./estimate` exports the fixed content estimator.

The status display combines the latest reported prompt usage with the latest recorded context capacity. Model changes can temporarily pair values from different requests. These approximate occupancy values serve the display; compaction uses the service's full surface measurement. The context breakdown estimates system text, tool declarations, and retained messages independently of provider billing.
