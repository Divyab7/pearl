# AI usage

Pearl was designed, directed and built by **Divya**. Claude Code (Anthropic, model Claude Opus 5.5) was the main coding tool. It wrote most of the code under Divya's direction, and Divya reviewed and accepted every change.

## What Divya did

**Idea and product**
- Came up with Pearl: a tamper-proof black box for robots, linked to insurance claims.
- Decided who it is for (insurers first, robot owners second) and what a claim looks like: payout by severity, one claim per human per incident.
- Set the safety rules: the robot freezes on its own, and the AI must never invent a decision.

**Architecture decisions**
- **Device-first:** the robot itself signs and publishes its record. The server can never fake one.
- **Privacy model:** logs are encrypted on the robot, only the owner holds the key, a claim shares the key for that one run only, and public records carry labels only.
- **Offline delivery:** a laptop relay, a Bluetooth courier and a robot-to-robot mesh for future multi-owner fleets.
- **Arkiv's role:** the robot's own run entries, plus live claim records updated at every step.
- **0G fallback chain:** other 0G models are tried only when the provider fails. A trust-mode last resort is allowed, and every attempt is recorded.

**Tracks and scope**
- Chose the tracks (0G Physical AI, Arkiv, World Agent Pass and IDKit) and checked each against the prize rules.
- Dropped Hedera and Chainlink to keep the scope realistic.
- Made every scope change. The AI had to ask before adding, dropping or narrowing anything.

**Hardware**
- Chose, bought and assembled the robot arm: ESP32-S3 N16R8, PCA9685, 4 × MG90 servos, VL53L0X, MPU6500, LED ring, buzzer.
- Did the wiring, power and board bring-up: the I2C scan, the sensor checks and the 2.4 GHz Wi-Fi setup.
- Set up the iPhone as the robot's camera.

**Accounts and setup**
- Created and configured the World ID Agent Pass client and the IDKit app.
- Set up the 0G API keys and funded the robot and operator wallets from the faucets.
- Set up the Vercel and Render deployments and the domain.

**Design and quality**
- Rejected the first UI as "not even bare minimum". Set the bar instead: an enterprise-grade product, understandable in under a minute, in plain language.
- Chose the final structure:
  - a landing page that sells to insurers first, with a role-based app behind it;
  - split sign-in, role first;
  - light theme only;
  - labelled demo workspaces, so judges without World ID can try everything;
  - Verify reached only through shared proof links.
- Asked for a copy review so that every sponsor, Arkiv in particular, is clearly visible, and for a pass to make the brand distinctive.

**Testing and demo**
- Ran the simulated and hardware runs, tested sign-in and claims, and made the demo.

## What the AI did

Claude Code agents, often several in parallel in separate git worktrees, did the following:

- Read the sponsor docs, SDK sources and live endpoints, and wrote code that cites them.
- Wrote the code for each part:
  - the robot program;
  - the 0G client and failsafe;
  - encryption and signing;
  - 0G Storage and the contracts;
  - Arkiv records;
  - the World ID flows;
  - claims;
  - the offline relay and mesh;
  - the web app;
  - the MuJoCo simulation;
  - the ESP32 firmware.
- Wrote the tests, including firmware tests checked against the TypeScript code.
- Debugged live problems with Divya: 0G Storage shard uploads, sensor drivers, serial output and Wi-Fi.
- Laid out options with trade-offs whenever Divya had a decision to make.
- Drafted these docs from the code and from live chain and Arkiv queries.

Almost every commit (118 of the first 122) carries a `Co-Authored-By: Claude Opus 5.5` line.

## Rules the AI worked under, set by Divya

- Never fake a 0G decision. Fail safe instead.
- Never print or commit secrets.
- Never move funds. Only Divya funds wallets.
- Ask before any scope change, and explain each choice in plain words.
