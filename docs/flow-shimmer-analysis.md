# 流光（Shimmer）效果对比分析与修复报告

参考项目：[XiangXtreme/claude-range-slider](https://github.com/XiangXtreme/claude-range-slider)（复刻 Claude 璨星动画）
本项目的对应实现：`src/renderer/EffortSlider.tsx` + `FlowLightCanvas.tsx` + `flowShader.ts`

---

## 1. 参考项目实现分析

### 1.1 架构

```
EffortCard.vue                只管模板与样式（SVG squircle 裁剪、滑块、翻转动画）
├─ composables/useSliderState.js   纯业务状态（值、标签、动画），无 DOM 依赖
└─ composables/useWebglFire.js     WebGL 引擎（context、FBO、渲染循环）
   └─ shaders/index.js             纯 GLSL 字符串：VERT / FRAG_SIM / FRAG_BLUR / FRAG_COMP
```

### 1.2 渲染机制：四通道 FBO 管线（关键差异）

每一帧跑四个 pass，其中模拟 pass 带 **ping-pong 反馈缓冲**：

1. **FRAG_SIM**：火焰模拟。读上一帧结果 `texture(u_back, uv)`，按 `prev * 0.90 * fade_mask` 衰减后叠加新的能量 → 输出到 FBO-B
2. **FRAG_BLUR（横向）**：7-tap 高斯模糊，且亮度 < 0.3 的像素不参与模糊（保护暗部）
3. **FRAG_BLUR（纵向）**：同上一个着色器，用 uniform 切换方向
4. **FRAG_COMP**：合成 + 色调映射 `fc = 1.0 - exp(-(s + g*1.2 + s*g*0.35) * 1.15)`，然后 ping-pong 交换 simA/simB

**核心算法洞察**：时间相干性（流动的连续感）来自**反馈缓冲的历史累积**，而不是更多层噪声。因此它可以用廉价的 `sin()` 叠加（f1/f2/f3 三条不同频率正弦）代替 fbm，每帧 3 个 pass 也依然流畅。

### 1.3 其他关键设计

| 设计点 | 做法 |
|---|---|
| 宽高比 | 细胞网格直接定义 `uv * vec2(72.0, 6.0)`——横向 72 格、纵向 6 格，比例天然匹配横条，不存在"修正"这回事 |
| 火焰前锋 | `u_slider` 是**目标值**，实际前锋 `front` 以三次缓动 `1-pow(1-x,3)` 逐渐追过去，每个细胞还有 `h*1.2s` 的随机点火延迟 → 有机的追赶感 |
| 颜色 | 余烬紫 → 亮紫 → 白，全部用 **mix 沿温度渐变**（`mix(col, wht, pow(temp, 4.5))`），加法项只有白核一处，且最终过色调映射 |
| 时间 | `u_time = rAF时间戳*0.001`，`u_elapsed` 用 `performance.now() - ultraStart` 计算，激活时刻才清零 |
| 精度 | 三个片段着色器全部 `precision highp float` |
| 性能 | `ResizeObserver`（80ms 防抖）替代每帧读尺寸；**空闲 180 帧自动停循环**（MAX_IDLE）；监听 `webglcontextlost/restored`；卸载时完整清理 FBO/程序/VAO/VBO/监听器 |

---

## 2. 逐项对比

| 维度 | claude-range-slider | 本项目（修复前） |
|---|---|---|
| **渲染机制** | 4-pass FBO 管线 + ping-pong 反馈缓冲，HDR 内部计算，合成时色调映射 | 单 pass 全屏三角形，直接画到画布，无 HDR、无色调映射 |
| **流动感来源** | 反馈缓冲历史衰减（时间相干）+ sin 火焰 | 空间噪声 fbm 域扭曲随时间漂移（无历史） |
| **动画帧处理** | rAF + 空闲自停（180 帧）；前锋缓动追赶目标值；elapsed 从激活时刻起算 | rAF 永不停止；`u_head` 直通目标值（瞬移）；`u_time` 用无界时钟 |
| **色彩过渡** | 全程 mix，加法项过 `1-exp(-x)` 色调映射，永不硬削波 | 加法 bloom 达 ~2.0，被 8-bit 缓冲硬削成纯白 |
| **精度** | highp | **mediump** |
| **宽高比** | 网格按轴直接定义（72×6） | `uv.y * aspect` —— 方向写反 |
| **尺寸响应** | ResizeObserver + 80ms 防抖 | 每帧 `getBoundingClientRect()` |
| **上下文管理** | lost/restored 监听 + 完整清理 | 无监听；卸载不释放 context 槽位 |

---

## 3. Bug 诊断（已全部数值验证，非猜测）

### Bug 1 — 宽高比修正作用在错误的轴上（最显著的视觉 bug）

`flowShader.ts` 原代码：

```glsl
vec2 warpP = vec2(uv.x, uv.y * aspect);   // ❌
```

注释声称"不修正则纵向密度高 10 倍"，但修正方向反了：横条 420×24px（aspect≈17.5），要把**宽轴**放大才能让噪声在像素空间各向同性。实测（对逐像素梯度求平均）：

| 实现 | 横向梯度/px | 纵向梯度/px | 各向异性 |
|---|---|---|---|
| 不修正 | 0.0145 | 0.138 | 9.5x |
| **原代码** | 0.0095 | 0.564 | **59.6x** |
| 修正后 | 0.170 | 0.168 | 1.0x |

原代码比不修正还差 6 倍：噪声被压进**亚像素级的竖向细条纹**（约 60:1），在屏幕上表现为闪烁的灯芯绒纹路，而非水平流动的光带。**这就是"流光变成噪点/闪烁"的第一根因。**

### Bug 2 — `precision mediump float` + 无界 `u_time` → 卡顿 + 闪烁

fbm 坐标含 `u_time * u_speed * 1.35` 项，随时间线性增长。mediump（10 位尾数）在坐标变大后无法分辨相邻像素/相邻帧：

| t(s) | 坐标量级 | mediump ULP | 坍缩像素数 | 冻结帧数 |
|---|---|---|---|---|
| 10 | 20 | 0.010 | 0.2 px | 0.3 帧 |
| **60** | 122 | 0.062 | **1.0 px** | **1.8 帧** |
| 300 | 608 | 0.311 | 5.1 px | 9.2 帧 |
| 1800 | 3645 | 3.73 | 61.7 px | 110.6 帧 |

约 1 分钟后相邻像素坍缩成同一噪声值（平坦色块），动画冻结数帧后整体跳一格 ULP——**正是"先卡住、再猛跳"的步进闪烁**。fp32 在正常会话时长内安全（这是"换台机器症状就变了"的典型着色器 bug：ANGLE/D3D 常把 mediump 提升为 fp32，部分集显/移动后端则严格照办）。

### Bug 3 — 头部 bloom 加法溢出 → 五个档位的头部全是同一种白色

原公式在 `uv.x == u_head` 处（glow=1）实测：

| 档位 | 头部颜色 (r,g,b) | 是否削波 |
|---|---|---|
| l0 | [1.57, 1.44, 1.96] | 是 → 白 |
| l2 | [1.34, 1.14, 1.94] | 是 → 白 |
| l4 | [1.86, 1.76, 1.98] | 是 → 白 |

8-bit 绘制缓冲硬削到 1.0，**五个档位在视觉焦点处全部坍缩成同一种纯白**——`FLOW_TIERS` 精心设计的调色板恰好在眼睛盯着的地方失效。这就是"颜色失真"的根因。参考项目用 mix 造颜色渐变、加法项过色调映射，从不硬削。

### Bug 4 — 高光 sheen 是一次性的，4 秒后永远消失

`sheenX = u_head - u_time * u_speed * 0.18` 从不回绕。u_head=0.7、speed=1.0 时，t≈4s 后 sheenX < 0 离开条带，**永不回来**。着色器注释承诺"moving specular highlight"，用户只在挂载头几秒见过一次。

### Bug 5 — `max === 0` 时 level 为 NaN → 渲染循环每帧抛 TypeError

`Composer.tsx` 传 `max={Math.max(0, effortTicks.length - 1)}`，单档位模型时为 0。`EffortSlider` 对 `data-level` 和 `pct` 都做了 `max > 0` 守卫，唯独漏了 `level` prop：

```tsx
data-level={max > 0 ? Math.round((boundedValue / max) * 4) : 0}   // ✅ 有守卫
level={Math.round((boundedValue / max) * 4)}                      // ❌ NaN
```

NaN 一路传进 `flowTierColors` → `FLOW_TIERS[Math.min(NaN+1, 4)]` → `undefined.to` → **TypeError，在 rAF 循环里每帧抛一次**。已用 Node 复现确认。

### Bug 6 — 两个"瞬移"：scrub 阶跃 + 档位换速

- 注释说 scrub "Ramps from 0 to 1 inside the shader loop"，实际只是 `setState(1)/setState(0)`，按下瞬间流速 ×2.6、松开瞬间 ÷2.6，无任何缓动积分器 → 每次按下/松开都可见地"抽搐"。
- 着色器内 `u_time * u_speed`：speed 由 0.5~1.5 档位阶跃，600 秒后 `u_time*speed` 从 600 跳到 750——**切换推理档位的瞬间整个噪声场传送 150 个单位**，表现为一次猛烈闪跳。

### Bug 7 — 性能与生命周期四连

1. **每帧强制布局**：rAF 循环每帧调 `getBoundingClientRect()` ≈ 3600 次布局读取/分钟，且与粒子层的 React 状态更新交替形成布局抖动。
2. **循环永不停止**：菜单收起（rect=0）时仍每帧空转；无参考项目那样的空闲停机。
3. **WebGL 上下文泄漏**：`pickerMode` 在 effort/model 之间每切换一次就卸载重挂一次 canvas，卸载只删了 program/buffer 没释放 context——Chromium 上限约 16 个活跃 context，反复切换后最旧的 canvas 永久黑屏。
4. **首帧闪烁**：`onReady?.()` 在**第一帧绘制之前**调用 → React 立即卸载 CSS 回退层，而画布此刻还是透明的 → 每次挂载闪现一帧空条。

另有粒子系统问题：`pointermove` 无节流（高回报率鼠标 100+ 事件/秒 × 每次 ≤17 粒），快速拖动持续打满 140 粒上限并整层重渲染。

### Bug 8 — 白色遮挡块（GPU 崩溃 × canvas 固有尺寸泄漏）

**现象**：选择器面板下方出现约 460×225 的不透明白块，左上角带"破图"样图标，遮挡 UI。

**取证**（逐像素分析截图 + CDP 实测，非猜测）：

1. 白块 461×225 截图像素；同图中面板实测宽 355px ≈ `min-width: 236` × 1.5 → 屏幕 150% 缩放 → 白块实际为 **CSS 300×150 = `<canvas>` 的默认固有尺寸**（宽高比 2:1 完全吻合）
2. 左上角"图标"实为**滑块把手**（14px 白方块深边框，`left:0% + translateX(-50%)` 恰好探出左缘），几何位置吻合
3. 自建 Electron 实例启动日志出现 `GPU process exited unexpectedly`——GPU 进程崩溃后，Chromium 将丢失的加速画布内容合成为**不透明白块**

**根因**（两个叠加）：

- **CSS**：`.flow-light-canvas` 用 `inset:1px + width/height:auto` 试图拉伸画布。canvas 是替换元素，`auto` 尺寸走**固有尺寸**而非拉伸，`right/bottom` 被直接忽略 → 画布始终以 300×150 悬浮在面板上层（`z-index:1`），平时画的是半透明紫光未被察觉，GPU 一崩即成刺眼白块
- **组件**：`getContext` 返回 null / 着色器编译失败 / 上下文丢失三条路径都直接 return——画布不隐藏、不再绘制，白色占位永久驻留；且画布初始 `opacity` 不为 0，首帧前也有白块闪现风险

**修复**：

- `styles.css`：`.flow-light-canvas` 改为 `inset:0; width:100%; height:100%`，显式钉在滑条内（替换元素必须显式给尺寸）+ 初始 `opacity:0`
- `FlowLightCanvas.tsx`：三条失败路径（无 WebGL2 / 程序链接失败 / `webglcontextlost`）统一隐藏画布（`display:none` 或 `opacity:0`）并触发 `onLost`；首帧 `gl.drawArrays` 之后才 `opacity:'1'` 并调 `onReady`；上下文恢复后重置 `firstFrameDrawn` 重新走揭示流程
- `EffortSlider.tsx`：新增 `markFlowLost` → `flowReady` 置 false → CSS 渐变回退层重新挂载，滑条不会空白

**效果**：GPU 崩溃的最坏结果 = 滑条退化为静态渐变（Graceful degradation），白色遮挡在结构上不可能再出现。若某台机器 GPU 进程反复崩溃，可在主进程 `app.disableHardwareAcceleration()` 兜底（未默认启用）。

### Bug 9 — 流光完全消失（StrictMode × loseContext 自毁）

**现象**：白块修复后，滑条只剩静态渐变，流光彻底消失。

**根因**：Bug 8 修复中为了解决 context 泄漏，在卸载清理里加了
`WEBGL_lose_context.loseContext()`。但 React **StrictMode**（dev 环境，本项目已启用）
会以"挂载 → 卸载 → 再挂载"的方式双跑 effect，且**复用同一个 canvas DOM 节点**：
1. 第一次挂载拿到 context；卸载清理调用 `loseContext()`
2. 二次挂载在同一 canvas 上 `getContext('webgl2')` —— 上下文已被显式销毁，**永久返回 null**
3. 新加的 `!gl` 防御分支把画布 `display:none` → 流光彻底不可见

教训：画布上下文与 DOM 元素同生命周期；只有元素真正离开文档后才允许释放。

**修复**：清理里的 `loseContext()` 推迟到下一帧执行，并检查 `canvas.isConnected`——
元素仍在文档中（StrictMode 重挂载）则跳过释放；真正卸载才释放。同时在两条失败路径
补 `console.warn`，杜绝静默失败。

**验证**（SwiftShader 软件 WebGL2 + CDP 实测，应用页面内）：
- 挂载后画布 buffer 与滑条尺寸一致（画布精确钉在条内），`opacity=1`，CSS 回退层卸载
- 着色器在应用页面内编译、链接通过，宿主声明的 uniform 均可绑定
- 拖动滑块到 100%（`data-level=4`）后连拍三帧，帧帧不同 → **动画确认**
- `loseContext()` 后 `opacity=0` + CSS 渐变回退层重新挂载 → 优雅降级确认

---

## 4. 修复方案（已全部落地）

### `flowShader.ts`

| 修复 | 改动 |
|---|---|
| Bug 1 | `warpP = vec2(uv.x * aspect, uv.y)` |
| Bug 2 | `precision highp float`（WebGL2/GLSL ES 3.00 强制支持 highp，不会编译失败） |
| Bug 2 | 时间不再进着色器坐标的绝对量级：宿主侧相位累加并 `% 4096` 回绕 |
| Bug 3 | bloom 改为 **mix 向亮色** `mix(color, mix(u_to, white, 0.25), glow*0.58)`，构造上有界；末尾 `min(color, 1.0)` 兜底，仅高光核心允许触顶 |
| Bug 4 | sheen 相位由宿主累加并 `% 1` 回绕（`sheenX = u_head - u_sheen * u_head`），从手柄向左缘循环扫掠 |
| Bug 5 | `flowTierColors` 对 NaN 回退到 tier 0 |
| Bug 6 | 移除 `u_speed` uniform，档位速度 × 缓动后的 scrub 全部烘进宿主侧相位推进速率——换档只改变速率，不再传送噪声场 |

### `FlowLightCanvas.tsx`

| 修复 | 改动 |
|---|---|
| Bug 6 | 渲染循环内两个缓动积分器：`headSmooth`（τ≈70ms，拖动/键盘跳变时前锋平滑追赶）、`scrubSmooth`（按下/松开渐入渐出） |
| Bug 5 | `level01` 读取处 `Number.isFinite` 兜底（与 flowTierColors 双保险） |
| Bug 7.1 | 尺寸改用 `ResizeObserver`，删掉每帧布局读取；`dt` 钳制 ≤ 1/30s，后台标签恢复时不瞬移 |
| Bug 7.2 | rect 为 0 时 `stop()` 循环，RO 报告非零尺寸时重启 |
| Bug 7.3 | 新增 `webglcontextlost/restored` 监听，恢复时重建程序；卸载后的 `loseContext()` 延后一帧，并在 canvas 仍连接时跳过，兼容 React StrictMode 重挂载 |
| Bug 7.4 | `onReady` 移到**第一帧绘制完成之后**，消除回退层卸载闪烁 |
| 其他 | 档位调色板按 level 缓存（原来每帧做 4 次 hex 解析 + 字符串分配） |

### `EffortSlider.tsx`

- `level={max > 0 ? Math.round(...) : 0}` —— 补上漏掉的守卫（Bug 5）
- 粒子发射帧节流（`event.timeStamp` 门控，16ms 一次）+ `prefers-reduced-motion` 下直接跳过发射

### `styles.css`

- `.flow-light-canvas`：`inset:0; width:100%; height:100%`（Bug 8——替换元素 auto 尺寸不拉伸）+ 初始 `opacity:0`（Bug 8——首帧前不可见）

### 当前视觉契约

- 五档累计保留六个色阶：青 → 浅蓝 → 靛蓝 → 紫 → 深紫；Max 可看到完整颜色链。
- 进入 Max 时整条彩色流体、流速和气泡密度增强 3 秒（最后 0.3 秒淡出），随后恢复常态。
- 轨道本身保持中性；密集方形 LED 纹理只在没有流体覆盖的区域可见，深浅主题都使用低对比间隙。
- WebGL 为主视觉，CSS 渐变只作失败回退；小方块 handle 始终位于画布上方，粒子只在拖动时出现。

### 有意不照抄参考项目的部分

四通道 FBO 管线 + 反馈缓冲的流动质感更好，但它是为"火焰"设计的：多 3 个 pass、4 张全屏 FBO 纹理、每帧 2 次 texture 采样往返。本项目的流光是**低饱和度的环境光效果**，单 pass fbm 在修复精度与宽高比后已足够；为此引入 4x GPU 开销不符合"muted、不抢戏"的定位。如果后续想要参考项目那种"点火—蔓延—余烬"的叙事感，反馈缓冲是正确的下一步。

---

## 5. 验证

**已通过的自动化验证**

- `tsc --noEmit`（web + node 两个 tsconfig）：通过
- `vitest run` 全量：**32 个文件 / 244 个测试全部通过**（其中 `flowShader.test.ts` 18 项，覆盖 uniform 漂移、`u_time * u_speed` 禁用、highp、宽高比、mix-bloom、sheen 回绕、累计调色板、Max 气泡与 NaN 回退）

**建议的手动验证清单（`pnpm dev` 后）**

1. **竖条纹消失**：对比修复前——光带应为平滑水平流动的条纹（见 `docs/flow-shader-compare.png` 下两行）
2. **头部颜色**：五个档位下头部应保留当前档位色调，不能全部洗成白色
3. **长跑测试**：挂机 10 分钟后动画应依旧平滑（不再出现"冻结数帧后跳格"）
4. **sheen 循环**：静止观察 ≥10 秒，高光应每隔几秒从手柄向左扫一次
5. **换档不闪跳**：拖动滑块跨越档位边界，噪声场应连续、仅流速/色调变化
6. **按下/松开**：流速应有明显的渐强渐弱，而非瞬间跳变
7. ** NaN 路径**：可临时把 `effortTicks` 缩到 1 项（max=0），滑杆应显示 tier 0 配色且控制台无报错
8. **上下文泄漏**：反复在 effort/model 面板间切换 30+ 次，流光不应黑屏
9. **减少动画**：系统开启"减少动态效果"后，粒子消失、光带静止为单帧
10. **白块不再现**：模拟 GPU 故障——在 DevTools 控制台执行
    `document.querySelector('.flow-light-canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()`
    后，滑条应立即退化为当前档位的静态累计渐变，无任何白色块；执行 `...restoreContext()`
    后流光应淡入恢复

## 6. 证据产物

- `docs/flow-shader-compare.png` — 修复前/后着色器输出渲染对比（同一噪声种子、同一几何）
- `.tmp-ref/verify-shader.mjs` / `verify-precision.mjs` / `render-compare.mjs` — 数值验证脚本，可随时重跑复核
