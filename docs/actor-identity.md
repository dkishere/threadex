# Workspace worker identity

## Standing decision

New workspace worker roots and sub-actors use Japanese anime girl characters for
their names and the Bot avatar direction below. In Threadex, use a Chinese
character name followed by a short Chinese role, for example `芙莉蓮 · 知識檢索`.
In Default, use an English or romanised character name and English role, for
example `Asuna Yuuki · Hiring Platform`. For another workspace, use its specified
language; ask if that language is unclear.

Characters and avatars must be unique within and across these workspaces. Before
choosing, inspect the current worker registries through the officially permitted
interfaces and the existing gallery. The snapshot below is historical and cannot
establish that a character remains available. Preserve existing workers: this
policy does not authorize creation or bulk changes, renaming, or changes to roles,
memory, models, allowlists, trees, projects or work bindings. It does not apply to
the server-wide consultant library.

## Adding an authorized worker

1. Check the current registry in each relevant workspace and the gallery for
   duplicate characters and avatars. Respect workspace and actor capabilities;
   do not fabricate an identity to query another workspace.
2. Choose a unique character and a name in the workspace's language. Generate an
   actual image with the available built-in image generation tool, one call per
   character, and inspect it. If the tool is unavailable, report that limitation;
   do not present a prompt or placeholder as a completed image. Any alternative
   generation method requires the explicit authorization specified by the imagegen
   skill; an actual image generated through an authorized method can be delivered.
3. Save the original in a versioned workspace asset location without overwriting
   earlier artwork. The [2026-10-28 gallery](../output/actor-avatars-20261028/README.md)
   records this set: 01–13 for Threadex, 14–23 for Default, with 14–16 `-v2`
   selected and the original versions selected for the rest.
4. Use the allowed creation and settings interfaces described in
   [Threadex configuration](../skills/threadex-config/SKILL.md). If the actor CLI
   cannot set an avatar, use an allowed settings path; do not bypass capabilities
   or write the database or browser storage directly. Back up existing name and
   avatar values before changing an existing worker.
5. Apply only the intended name and avatar via the supported actor settings API.
   Omitting `avatar` preserves it; `null` clears it. Local image paths are not
   stored as avatars. The existing editor centre-crops to 128×128 WebP at 0.85;
   the avatar validator limits the data URL to 65,536 characters. Confirm persistence
   with a fresh GET, then verify that `/actors/summary` carries the avatar and that
   the sidebar and chat actually render it. Keep unrelated settings intact.

## Reusable image direction

For each character, adapt this prompt to their recognisable hair and accessories:

> Create a square, minimalist flat 2D Bot portrait of [character], retaining
> [hair colour, hairstyle and signature accessories]. Use a large round
> cream-white face, two equal parallel upright capsule eyes and faint blush,
> with no mouth or nose. Place the head against solid charcoal black, filling
> roughly 85–90% of the frame, entering from the lower left and tilted clockwise
> about 20 degrees. Keep both eyes complete and a little background in the upper
> right. No body, text, name, logo, circular frame, weapons or particles.

Simple capsule eyes are the target. Small highlights or gradients were accepted
in this set; avoid full pupils and whites, excessive eyelashes and bodies, and
keep the set visually consistent. The direction is inspired by the
[Grok Bot-style avatar prompt](https://www.meowtool.com/en/grok-bot-avatar-prompt/).

## Confirmed snapshot, 2026-10-28

These names are the recorded result, not a substitute for querying the current
registry before a new choice. The [gallery](../output/actor-avatars-20261028/README.md)
and its `after.json` provide the contemporaneous artwork and API snapshot.

| Workspace | Worker names |
| --- | --- |
| Threadex | 木之本櫻 · 任務規劃; 安妮亞 · 介面體驗; 御坂美琴 · 模型分析; 錦木千束 · 執行程序; 蝴蝶忍 · 審查變更; 芙莉蓮 · 知識檢索; 琪琪 · 瀏覽器檔案; 約兒 · Workspace安全; 愛蜜莉雅 · 資料同步; 薇爾莉特 · 平台部署; 初音未來 · Actors協作; 月野兔 · Manager介面; 雷姆 · BDD驗證 |
| Default | Asuna Yuuki · Hiring Platform; Maomao · Local Environment; Rei Ayanami · Cloud Infrastructure; Homura Akemi · End-to-End Testing; Rin Tohsaka · Data Models and APIs; Nobara Kugisaki · Diagnostics; Rukia Kuchiki · Code Review; Zero Two · Tools and Automation; Marin Kitagawa · Developer Productivity; Madoka Kaname · Red Panda |

The recorded UI uses 48px list avatars and 56px chat avatars, reducing chat
avatars to 48px at widths of 650px or less. These observations do not require
CSS changes when adding a worker. Implementation references:
[avatar validation](../src/actorAvatar.ts), [upload conversion](../src/client/ActorAvatar.tsx)
and [worker summary](../src/server/domainActorSummary.ts).
