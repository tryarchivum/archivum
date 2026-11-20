TRANSCRIPT trn_evalcontra000000000001 source=claude-code events=5

SYSTEM:
Session date: 2026-02-02. Project: fennelq, a small job queue with workers. Version 0.8.2.

USER:
Jobs keep failing and retrying too fast. How do retries work, and how do I run more workers?

ASSISTANT:
I will read the README section on retries and the worker help.

TOOL bash:
$ grep -n -i -A2 "backoff" README.md
41:Retries use exponential backoff starting at 2 seconds, doubling each time.
42:A job is given up after 5 attempts and moved to the dead-letter queue.
$ fennelq worker --help
usage: fennelq worker [--concurrency N] [--max-attempts N]
  --concurrency N    jobs run in parallel (default 1)
  --max-attempts N   attempts before dead-lettering (default 5)

ASSISTANT:
According to the README, the retry backoff starts at 2 seconds and doubles; jobs are dead-lettered after 5 attempts. For more throughput run `fennelq worker --concurrency 8 --max-attempts 5`; the default concurrency is 1.
