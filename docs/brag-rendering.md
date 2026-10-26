# BRAG rendering on AWS

When using the installed BRAG skill to render a video from the long-running
Codex EC2 host, start a **new, time-bounded Spot EC2** for the render. The host
is a small `t4g.micro` with limited free RAM and disk; it should orchestrate,
not run Hyperframes, Chromium, FFmpeg, or a Node 22 toolchain.

- Check for an existing render job before launching a new instance.
- Use enough memory and disk for the render, set instance-initiated shutdown
  to **terminate**, and enforce a hard timeout.
- Upload the video, storyboard/plan, logs, and useful debug artifacts to S3
  before shutting down, including on failure where possible.
- Verify the artifacts and that the Spot instance terminated. Never leave an
  idle render instance running.
- If Spot capacity is unavailable, report the blocker; do not silently use
  On-Demand or render on the long-running host.
- Inspection or planning without rendering does not require an instance.

The live instruction is also in `/home/ubuntu/.codex/skills/brag/SKILL.md`.
That installed skill is not versioned in this repo, so reapply this rule if
the skill is reinstalled or updated.
