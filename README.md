# c2c-005 · 声音表情包工坊

Vue 3 + TypeScript + Vite 纯前端声音创作工具。支持最长 10 秒录音/导入、裁剪、声学特征情绪匹配、Canvas 封面、IndexedDB 本地作品集和系统文件分享。

## 架构

- `src/core`：作品模型、特征归一化、情绪规则、有效声音判定与封面预设
- `src/ports`：录音、音频、Canvas、仓储与分享接口
- `src/adapters`：MediaRecorder、Web Audio、Canvas、IndexedDB、Web Share 实现
- `src/ui`：Vue 阶段式工作流和原生 CSS

## 有效声音判定

情绪匹配前先经过语音活动闸门（`src/core/voice-detector.ts`，纯函数、无随机数）：
自适应本底噪声门槛（P20 基线 +9 dB）叠加 −45 dBFS 绝对地板，再用声段调制深度
（5~25 dB）区分讲话与持续底噪，用脉冲包络/最短时长排除单次响声。未通过时
界面只显示有效时长、停顿与无法分析的原因，不给出自动百分比；用户仍可手动
选择标签并以“人工选择”来源保存。判定方案与误判对照见
[`docs/valid-voice-detection.md`](docs/valid-voice-detection.md)。

## 运行

```bash
npm install
npm run dev
npm run build
docker compose up --build
```

本地开发默认由 Vite 提供；Docker 部署访问 `http://localhost:8105`。浏览器录音在非 localhost 环境通常需要 HTTPS 和麦克风权限。

声音只保存在本机 IndexedDB，不会上传。生成的分享链接仅承载标题、情绪和封面配置，不包含原始音频；文件分享不受此限制。情绪识别是娱乐性启发式结果，不代表身份、性格或医学判断。
