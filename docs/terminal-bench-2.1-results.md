# ACC on Terminal-Bench 2.1: evaluation report

Updated October 30, 2026.

Terminal Coding Agent (ACC), using DeepSeek Flash with high reasoning effort, completed an evaluation covering all 89 Terminal-Bench 2.1 tasks through Harbor. The recorded results were **78 passes (87.6%)** and **11 failures (12.4%)**.

| Setting | Recorded configuration |
| --- | --- |
| Agent | ACC 0.1.0 |
| Coding model | DeepSeek Flash (`deepseek-flash`), high reasoning effort |
| Harness | Harbor 0.23.0; adapter 0.1.0 |
| Permissions | `auto-edits`; automatic confirmation enabled; sandbox off |
| Execution | Sequential containers; task-specific deadlines; ARM64 and AMD64 emulation |

## Task results

Selection: one recorded result per task across run dates and ACC source revisions. Evidence links contain selected, sanitized metadata, not full original logs.

| Task | Raw verifier reward | Outcome | Observation | Sanitized evidence |
| --- | ---: | --- | --- | --- |
| `fix-git` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/fix-git.json) |
| `kv-store-grpc` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/kv-store-grpc.json) |
| `log-summary-date-ranges` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/log-summary-date-ranges.json) |
| `prove-plus-comm` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/prove-plus-comm.json) |
| `regex-log` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/regex-log.json) |
| `constraints-scheduling` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/constraints-scheduling.json) |
| `openssl-selfsigned-cert` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/openssl-selfsigned-cert.json) |
| `code-from-image` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/code-from-image.json) |
| `chess-best-move` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/chess-best-move.json) |
| `gcode-to-text` | 0.0 | Verifier fail | Agent timed out; out.txt missing (0/2 tests passed). | [Sanitized result](evaluation-results/terminal-bench-2.1/gcode-to-text.json) |
| `password-recovery` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/password-recovery.json) |
| `vulnerable-secret` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/vulnerable-secret.json) |
| `sqlite-db-truncate` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/sqlite-db-truncate.json) |
| `git-leak-recovery` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/git-leak-recovery.json) |
| `polyglot-c-py` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/polyglot-c-py.json) |
| `polyglot-rust-c` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/polyglot-rust-c.json) |
| `distribution-search` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/distribution-search.json) |
| `raman-fitting` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/raman-fitting.json) |
| `sparql-university` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/sparql-university.json) |
| `multi-source-data-merger` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/multi-source-data-merger.json) |
| `db-wal-recovery` | 0.0 | Verifier fail | ID 1 value 1000; expected 150 (5/7 tests). | [Sanitized result](evaluation-results/terminal-bench-2.1/db-wal-recovery.json) |
| `modernize-scientific-stack` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/modernize-scientific-stack.json) |
| `cancel-async-tasks` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/cancel-async-tasks.json) |
| `build-pmars` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/build-pmars.json) |
| `break-filter-js-from-html` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/break-filter-js-from-html.json) |
| `custom-memory-heap-crash` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/custom-memory-heap-crash.json) |
| `large-scale-text-editing` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/large-scale-text-editing.json) |
| `configure-git-webserver` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/configure-git-webserver.json) |
| `nginx-request-logging` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/nginx-request-logging.json) |
| `pypi-server` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/pypi-server.json) |
| `cobol-modernization` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/cobol-modernization.json) |
| `headless-terminal` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/headless-terminal.json) |
| `git-multibranch` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/git-multibranch.json) |
| `extract-elf` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/extract-elf.json) |
| `fix-code-vulnerability` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/fix-code-vulnerability.json) |
| `dna-insert` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/dna-insert.json) |
| `dna-assembly` | 0.0 | Verifier fail | Input primer pair Tm difference 6.88°C exceeds 5°C. | [Sanitized result](evaluation-results/terminal-bench-2.1/dna-assembly.json) |
| `feal-differential-cryptanalysis` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/feal-differential-cryptanalysis.json) |
| `feal-linear-cryptanalysis` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/feal-linear-cryptanalysis.json) |
| `model-extraction-relu-logits` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/model-extraction-relu-logits.json) |
| `regex-chess` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/regex-chess.json) |
| `merge-diff-arc-agi-task` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/merge-diff-arc-agi-task.json) |
| `schemelike-metacircular-eval` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/schemelike-metacircular-eval.json) |
| `largest-eigenval` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/largest-eigenval.json) |
| `protein-assembly` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/protein-assembly.json) |
| `write-compressor` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/write-compressor.json) |
| `llm-inference-batching-scheduler` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/llm-inference-batching-scheduler.json) |
| `build-cython-ext` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/build-cython-ext.json) |
| `bn-fit-modify` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/bn-fit-modify.json) |
| `adaptive-rejection-sampler` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/adaptive-rejection-sampler.json) |
| `count-dataset-tokens` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/count-dataset-tokens.json) |
| `mteb-leaderboard` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/mteb-leaderboard.json) |
| `mteb-retrieve` | 0.0 | Verifier fail | Saved line differed from expected output (1/2 tests). | [Sanitized result](evaluation-results/terminal-bench-2.1/mteb-retrieve.json) |
| `hf-model-inference` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/hf-model-inference.json) |
| `pytorch-model-cli` | 0.0 | Verifier fail | 5/6 checks; 10 prediction mismatches in the 50-image check. | [Sanitized result](evaluation-results/terminal-bench-2.1/pytorch-model-cli.json) |
| `pytorch-model-recovery` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/pytorch-model-recovery.json) |
| `qemu-startup` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/qemu-startup.json) |
| `qemu-alpine-ssh` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/qemu-alpine-ssh.json) |
| `install-windows-3.11` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/install-windows-3.11.json) |
| `overfull-hbox` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/overfull-hbox.json) |
| `financial-document-processor` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/financial-document-processor.json) |
| `extract-moves-from-video` | 0.0 | Verifier fail | Tools installed beforehand; agent timed out, solution.txt missing (0/2 tests). | [Sanitized result](evaluation-results/terminal-bench-2.1/extract-moves-from-video.json) |
| `video-processing` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/video-processing.json) |
| `sanitize-git-repo` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/sanitize-git-repo.json) |
| `crack-7z-hash` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/crack-7z-hash.json) |
| `make-doom-for-mips` | 0.0 | Verifier fail | Sprite initialization error; agent timed out; no frame (0/3). | [Sanitized result](evaluation-results/terminal-bench-2.1/make-doom-for-mips.json) |
| `make-mips-interpreter` | 0.0 | Verifier fail | Expected startup text missing; frame and image checks passed (2/3). | [Sanitized result](evaluation-results/terminal-bench-2.1/make-mips-interpreter.json) |
| `tune-mjcf` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/tune-mjcf.json) |
| `mailman` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/mailman.json) |
| `sqlite-with-gcov` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/sqlite-with-gcov.json) |
| `path-tracing` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/path-tracing.json) |
| `path-tracing-reverse` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/path-tracing-reverse.json) |
| `query-optimize` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/query-optimize.json) |
| `build-pov-ray` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/build-pov-ray.json) |
| `compile-compcert` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/compile-compcert.json) |
| `fix-ocaml-gc` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/fix-ocaml-gc.json) |
| `filter-js-from-html` | 0.0 | Verifier fail | Batched XSS alert; cause unresolved. Clean-HTML false positive; browser errors reduced coverage. | [Sanitized result](evaluation-results/terminal-bench-2.1/filter-js-from-html.json) |
| `portfolio-optimization` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/portfolio-optimization.json) |
| `gpt2-codegolf` | 1.0 | Verifier pass | Agent reached native 900s timeout. AgentTimeoutError | [Sanitized result](evaluation-results/terminal-bench-2.1/gpt2-codegolf.json) |
| `circuit-fibsqrt` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/circuit-fibsqrt.json) |
| `torch-tensor-parallelism` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/torch-tensor-parallelism.json) |
| `torch-pipeline-parallelism` | 0.0 | Verifier fail | Prepared environment; lm_head backward mismatches at world sizes 1/2. | [Sanitized result](evaluation-results/terminal-bench-2.1/torch-pipeline-parallelism.json) |
| `sam-cell-seg` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/sam-cell-seg.json) |
| `train-fasttext` | 0.0 | Verifier fail | Accuracy 0.579 below 0.62. | [Sanitized result](evaluation-results/terminal-bench-2.1/train-fasttext.json) |
| `winning-avg-corewars` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/winning-avg-corewars.json) |
| `caffe-cifar-10` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/caffe-cifar-10.json) |
| `mcmc-sampling-stan` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/mcmc-sampling-stan.json) |
| `rstan-to-pystan` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/rstan-to-pystan.json) |
| `reshard-c4-data` | 1.0 | Verifier pass | — | [Sanitized result](evaluation-results/terminal-bench-2.1/reshard-c4-data.json) |
