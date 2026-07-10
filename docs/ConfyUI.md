

你要做的是 ComfyUI + SDXL + IP-Adapter + AnimateDiff（Evolved） 专业级本地部署，这是目前 ComfyUI 里显存需求最高的组合之一。下面给你硬件选型、完整部署步骤、模型摆放、工作流要点和注意事项。

一、硬件配置推荐（重点看显存）

SDXL Base(~6.5GB FP16) + AnimateDiff Motion Module(~3.5GB) + IP-Adapter Plus SDXL(~2.5GB) + 帧缓冲(16帧,~3-4GB) + 工作内存 ≈ 峰值 15–17GB VRAM

等级 显卡 能否跑此组合 说明

✅ 专业推荐 RTX 3090 / RTX 4090 (24GB) 流畅，模型全驻留显存 24GB 是此工作流的甜点区

⚠️ 极限妥协 RTX 4070 Ti SUPER / 4080 (16GB) 可跑但紧张 需降帧数(≤12帧)、降分辨率、关其他CN，IP-Adapter仍可用

❌ 不推荐 RTX 3060 12GB / 4060 8GB 基本跑不动 SDXL+AnimateDiff同屏 必 OOM，除非改用 SD1.5+AnimateDiff

💻 系统其他 CPU Ryzen 5 5600X / i5-12400F+ · RAM ≥32GB DDR4/5 · SSD ≥1TB NVMe 避免加载卡顿崩溃

结论：专业做这组合强烈建议 NVIDIA RTX 3090（二手性价比）或 RTX 4090（新机）24GB，12GB 卡无法舒适运行 SDXL+AnimateDiff+IP-Adapter 同管线。

二、ComfyUI 部署（Windows 推荐方式）

方式A：官方便携包（最简单）

# 1. 下载 ComfyUI_windows_portable_nvidia.7z
# https://github.com/comfyanonymous/ComfyUI/releases

# 2. 解压后双击 run_nvidia_gpu.bat
# 浏览器访问 http://127.0.0.1:8188


方式B：手动 Git 安装（灵活）

git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv
venv\Scripts\activate   # Windows
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
python main.py

Python 推荐 3.10～3.11，CUDA 11.8 或 12.x 均可，NVIDIA 驱动 ≥525

三、必装自定义节点 & 模型放置

1. 安装 ComfyUI-Manager（强烈推荐）

进入 ComfyUI/custom_nodes/：
git clone https://github.com/ltdrdata/ComfyUI-Manager.git

重启 ComfyUI → 点 Manager → Install Custom Nodes 搜下面两个安装：

• ComfyUI-AnimateDiff-Evolved（Kosinkadink 版，支持 SDXL 运动模块）




https://www.autodl.com

- ComfyUI_IPAdapter_plus（搜索 ipadapter 选此）

2. 模型文件摆放

文件类型 放入路径 说明

SDXL Checkpoint (.safetensors) ComfyUI/models/checkpoints/ 如 juggernautXL / animagineXL

SDXL VAE ComfyUI/models/vae/ 可选，推荐搭配 SDXL VAE fp16 fix

AnimateDiff Motion Module ComfyUI/models/animatediff_models/ mm_sd_v15_v2.ckpt 或 SDXL版运动模块

IP-Adapter Model (SDXL) ComfyUI/models/ipadapter/ ip-adapter-plus-face_sdxl_vit-h.bin 或 sdxl_plus_vit-h

IP-Adapter CLIP-ViT ComfyUI/models/clip_vision/ CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors

LoRA ComfyUI/models/loras/ 角色/风格 LoRA

四、工作流节点连接要点（SDXL + IP-Adapter + AnimateDiff）

核心节点链路：

Load Checkpoint(SDXL)
  ├── MODEL → IPAdapter (加载IP-Adapter模型+参考图+CLIP_VISION)
  │             └── MODEL → AnimateDiff Loader(加载Motion Module, apply_on=Model)
  │                          └── MODEL → KSampler(context_options可选)
  ├── CLIP → CLIP Text Encode(SDXL Positive/Negative)
  └── VAE → VAE Decode → Save Animated(或Video Combine)


关键参数建议：
• AnimateDiff：Motion Module 选 v2（角色一致性更好）或 v3（动作更顺）；帧数 16 帧起，batch_size=16，context_length=16，overlap=4~8

- IP-Adapter weight：动画推荐 0.6～0.8，角色锁定可提到 0.85；过高(>0.9)会抑制运动产生僵住
• Sampler：DPM++ 2M Karras，steps 25～30，CFG 5～7

- 分辨率：SDXL AnimateDiff 建议先 512×768 或 576×1024 测试，再升采样

五、重要注意事项 & 避坑

1. 必须用 NVIDIA 卡 + CUDA，AMD 对 AnimateDiff/IP-Adapter 支持差且慢
2. 显存不够不要强开：12GB 卡跑此组合会 OOM，可降为 SD1.5+AnimateDiff+IP-Adapter 替代练习
3. IP-Adapter SDXL 要用对应模型：别把 SD1.5 的 ip-adapter 放进去，需下载 _sdxl_ 后缀版本，且 CLIP Vision 必须匹配
4. AnimateDiff-Evolved 不是旧版 AnimateDiff：旧节点不支持 SDXL 运动模块上下文管理，务必用 Evolved 分支
5. xformers 可选开启（便携版自带）：启动加 --xformers 可降低显存碎片，提速约 10～20%
6. 模型总量大：SDXL(~7GB)+AnimateDiff(~3.5GB)+IP-Adapter(~2.5GB)，建议预留 至少 20GB 空闲 SSD，多模型仓库建议 1TB+
7. 角色一致性技巧：锁 seed、用同一参考图做 IP-Adapter、短片段(12-16帧)生成后外部剪辑拼接

六、参考文档 / 延伸阅读

• ComfyUI 官方：https://github.com/comfyanonymous/ComfyUI 

- AnimateDiff-Evolved：https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved 
• IP-Adapter 官方（含 SDXL 模型下载）：https://github.com/tencent-ailab/IP-Adapter

- ComfyUI IPAdapter Plus：https://github.com/cubiq/ComfyUI_IPAdapter_plus
• AnimateDiff + IP-Adapter ComfyUI 实战参考：https://www.apatero.com/blog/animatediff-ipadapter-combo-comfyui-complete-guide-2025 

如果你已经选定了具体显卡型号（比如纠结 3090 二手 vs 4070 Ti SUPER 16G），或者需要我给你一份可直接导入的 SDXL+IP-Adapter+AnimateDiff workflow.json 示例说明，可以继续问！




针对你要跑 ComfyUI + SDXL + IP-Adapter + AnimateDiff（需 24GB 显存），给你两种台式机整机预算方案（2026年6月国内电商参考价）：

一、RTX 4090（全新）24GB —— 推荐专业方案

配件 推荐型号 参考价

显卡 RTX 4090 24GB（华硕/微星/七彩虹等） ¥12,800～13,800

CPU AMD R9 7900X / Intel i7-14700K ¥2,200～2,800

主板 B650（AM5）/ Z790（Intel），PCIe 4.0+ ¥1,200～1,800

内存 64GB DDR5-6000（32G×2，跑多模型/缓存） ¥1,100～1,400

固态 2TB PCIe 4.0 NVMe（三星990 Pro/致态） ¥900～1,200

电源 1000W 金牌+ ATX 3.0（原生12VHPWR） ¥900～1,200

散热+机箱 360水冷/双塔风冷 + 全塔网孔机箱 ¥700～1,000

整机合计 ≈ ¥19,800～21,500

如果选 Ryzen 5 7600 / i5-13600K + 32GB 内存缩配，最低可压到 ≈ ¥17,500～18,500，但建议留足余量。

二、RTX 3090（二手）24GB —— 高性价比备选

二手 3090 同样 24GB 显存，能跑 SDXL+AnimateDiff+IP-Adapter，只是生成速度慢约 30～40%、功耗更高（350W）。

配件 说明 参考价

显卡 二手 RTX 3090 24GB（成色好的品牌卡） ¥5,500～7,000

其余配件 同缩配版（i5/R5 + 32～64GB + 850W 电源） ¥4,000～5,000

整机合计 ≈ ¥9,500～12,000

⚠️ 二手矿卡风险需注意，建议找支持店保的商家，电源务必 850W+ 金牌。

三、关键注意事项

• 电源必须 ATX 3.0 / 原生 12VHPWR：RTX 4090 用原生 16pin 线，别转接多根 8pin，防熔线

- 机箱空间：4090 三风扇长约 330～355mm，买机箱确认 GPU 限长 ≥355mm、宽度不挡底部进风
• 内存建议 64GB：ComfyUI 加载多模型+VAE+AnimateDiff 时系统内存占用不低，32GB 刚够，64GB 更从容

- 驱动：装 Studio Driver（不是 Game Ready），对 ComfyUI/CUDA 更稳定
• 二手 3090 散热：GDDR6X 显存易过 90℃，确保机箱前后进排风足够

小结建议

• 预算充裕、商用/高频出图 → 全新 RTX 4090 整机 ≈ 2～2.1 万，速度快体验好

• 个人学习/预算敏感 → 二手 RTX 3090 整机 ≈ 1～1.2 万，24GB 显存一样能跑通工作流

如果定好方案想拿具体品牌型号清单（含淘宝/京东大致链接方向），或纠结 3090 二手坑怎么避，可以继续问！