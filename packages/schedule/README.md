# Codexy Schedule

`@codexydsh/schedule` installs durable session-local reminder tools on root agents created after the plugin loads. Child agents receive no schedule tools, and Agent disposal removes its tools and timers. The released Host Schedule service remains available for its separate global task interface.

`schedule_create` accepts a positive delay, an absolute time with an explicit UTC offset or IANA zone, or a fixed interval of at least five minutes. `schedule_list` and `schedule_delete` read and mutate the owning Session. Every mutation and delivery uses the shared persistence barrier; fixed-rate delivery combines overdue occurrences into one batch without moving the creation anchor. Archive admission reports active reminders and records durable deletions when a session is stopped.

The product records `schedule/change` in a required Codexy fact envelope and projects it for replay, resumed timers, and inherited-prefix exclusion. This keeps the product’s agent-scoped reminder format separate from the released Host task format.
