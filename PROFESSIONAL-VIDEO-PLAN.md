# 专业视频生成（成片）实现方案

目标:把"文案 → 一条对得上文案、风格连贯的完整成片"做成可靠流水线。
范围:用户已选 **全流程成片 P1+P2+P3**。

## 根因(为什么现在不匹配)

`lily-video-generation/SKILL.md` 只有机械式"把一句 prompt 丢给脚本",没有导演层:
不拆分镜、不做结构化提示词、不锁角色/画风一致性。文生视频模型对 prompt 极敏感,
弱 prompt → 泛泛画面 → 跟文案对不上。我们已有图片/视频/语音三块生成原语,缺
**导演层** 和 **拼装层(ffmpeg)**。

## 分层(定稿)

- **技能 = 轻量原子能力**:`lily-video-generation`/`image`/`speech` 各自只做一件事
  (出一条片段 / 一张图 / 一段配音)+ 轻量提示词指导。**不含** ffmpeg/成片编排。
- **应用 = 重型组合工作流**:「视频创作」app 拥有 `generate-film.cjs`(成片编排)+
  `setup-ffmpeg.cjs`(按需备 ffmpeg/字体),orchestrate 上述技能。app 里的 producer
  通过 `LILY_USER_DATA_DIR` 自动定位已安装技能脚本,不与技能目录耦合。

## 架构(Rule 5:LLM 判断 / 代码确定性)

```
文案 ──[导演: LLM]──► storyboard.json ──[制片: generate-film.cjs 确定性编排]──► 成片.mp4
                                              ├─ 关键帧(图片 skill, 锁角色/画风)
                                              ├─ 逐镜图生视频(视频 skill, first_frame=关键帧)
                                              ├─ 旁白配音(语音 skill, 逐镜 narration)
                                              └─ ffmpeg: 拼接 + 字幕烧录 + 配乐混音
```

storyboard.json 是导演与制片之间的契约。

### storyboard.json schema

```json
{
  "title": "片名",
  "aspectRatio": "16:9",            // 16:9 | 9:16 | 1:1
  "style": "全局画风圣经,每镜逐字复用:电影感写实/仙侠水墨/暖色调…",
  "character": "主角一致性锚点:少年修士,素色道袍,黑发束起,手腕暗金纹路",
  "voice": "longanyang",            // TTS 音色,可空走默认
  "musicMood": "epic",              // 可空
  "subtitles": true,
  "shots": [
    {
      "id": 1,
      "duration": 5,                // 单镜秒数(模型上限内)
      "keyframe": "图片提示词(含 character+style),作图生视频首帧 — P2",
      "prompt": "镜头视觉描述:主体+动作+环境+景别/运镜+光线/氛围(含 style)",
      "narration": "这一镜旁白(用于 TTS + 字幕)— P3,可空"
    }
  ]
}
```

## 分阶段

- **P1 导演层(本次,零新依赖)**:重写 `lily-video-generation/SKILL.md`,教 agent
  当导演——文案→分镜→结构化 prompt 模板→一致性锁定→反面清单;并定义
  storyboard.json 输出。保留单镜简单路径。bump manifest 版本(否则版本门槛不下发)。
  *立刻改善"不匹配",即使 P2/P3 未完成也可用(多镜手动生成)。*

- **P2 一致性(图生视频)**:导演产出 `keyframe`;制片先用图片 skill 生成关键帧,
  再以 `media:[{type:"first_frame",url}]` 逐镜图生视频,锁死角色长相+画风。无新依赖。

- **P3 成片拼装(ffmpeg)**:新增 `generate-film.cjs` 制片脚本,吃 storyboard.json:
  关键帧→逐镜图生视频→逐镜 TTS→ffmpeg(拼接 + 字幕烧录 + 配乐)→ 成片.mp4。
  **依赖:打包 ffmpeg**。方案 = 复用引擎那套 `fetch-*` 模式,按平台拉静态 ffmpeg 到
  `bundles/<plat>/ffmpeg/`,经 `bundle-locator` 解析(像 opencode 引擎一样);打包后
  自检校验存在+可执行(复用 verify-engine-bundle 思路)。

## Capability-gate

- 失败降级到今天行为:导演方法任何一步失败 → 退回单镜简单 prompt(不更差)。
- ffmpeg 缺失 → 成片 fail-loud(明确报错 + 返回各分镜散片),绝不静默产出坏成片。
- 第三方视频模型是硬上限,流水线只优化我们可控的(导演/一致性/后期)。

## 进度

- [x] P1 导演层 — 重写 SKILL.md(导演方法/结构化提示词/一致性/反面清单)+ 成片入口;manifest 1.1.0→1.3.0
- [x] P2 关键帧一致性 — producer 用图片 skill 出关键帧 → 即梦 i2v(first_frame)逐镜锁一致性
- [x] P3 成片引擎 — `generate-film.cjs`(归一化 + 旁白同步裁/补 + 字幕烧录 + concat + BGM ducking),`test-film-assembly.mjs` 用合成素材实测出片(video+audio 流、时长、分辨率)
- [ ] **最后一公里(打包)**:按平台拉静态 ffmpeg → `bundles/<plat>/ffmpeg/`(`resolveFfmpeg` 已就绪);打包自检(复用 verify 思路);electron-builder extraResources;烧录中文字幕需随包 CJK 字体(`SUBTITLE_FONT`,缺则 fail-open 跳字幕)

> 现状:**从源码运行(ffmpeg 在 PATH)+ 配好视频/语音/图片 API,现在就能 `文案→storyboard→一条成片`。** 打包给最终用户还差 ffmpeg/字体随包。
