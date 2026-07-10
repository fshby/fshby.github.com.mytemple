codex 因为codex自带模型成本和使用上受限，将模型替换为deepseek（不支持多模态）模型

安装步骤
1、下载安装codex（免费）  ----https://openai.com/zh-Hans-CN/codex/
2、安装 CC Switch （免费） ----https://ccswitch.io/zh/    windows安装CC-Switch-v3.16.4-Windows.msi
1)选择openAI图标点击右侧＋号添加模型deepseek
2)填写apikey;打开本地路由映射开关
3)开启路由---左上角点击设置→路由总开关→勾选codex→测试-运行正常
4)退出重新打开codex，查看左下角时通过api密钥登录Logged in with API key
3、获取deepseek官网api ----https://platform.deepseek.com/usage   API KeyS 创建apk key   ----sk-e6ebde1e436e4d76ba2336782924885f


| 路径 | 说明 |
|------|------|
| `C:\Users\kfzheng\AppData\Local\OpenAI\Codex\bin\aec6b7c6fcdfb66a\codex.exe` | **主程序**（约 308 MB） |
| `C:\Users\kfzheng\AppData\Local\OpenAI\Codex\bin\ada252862d154cdd\rg.exe` | 搜索工具 `rg` |
| `C:\Users\kfzheng\AppData\Local\OpenAI\Codex\runtimes\cua_node\` | Node.js 运行时 |
| `C:\Users\kfzheng\AppData\Local\Codex\Logs\` | 日志文件 |



当前工作目录是：

```
C:\Users\kfzheng\Documents\Codex\2026-06-28\ni-ha
```

这也是我们这个线程的专属文件夹，里面有两个子目录：

| 目录 | 用途 |
|------|------|
| `outputs\` | 存放最终的交付文件 |
| `work\` | 存放中间文件、草稿、临时脚本 |

有什么想在这里创建的吗？??



汉化包方案一需要梯子


Codex 桌面版界面汉化步骤
打开设置
启动 Codex → 点击左上角 File → Settings，或直接点左下角?齿轮图标 / 按 Ctrl + ,
选择语言
进入 General（常规）? 标签页
找到 Language / Language for the app UI
下拉选择 Chinese (China) / 简体中文（zh-CN）
完全退出并重启
关闭 Codex（确认系统托盘也无残留进程）→ 重新打开，界面即变中文

汉化备用方案：


sk-e6ebde1e436e4d76ba2336782924885f




有显卡、想专业做ComfyUI + SDXL + IP-Adapter + AnimateDif



Codex Desktop 简体中文汉化教程（Windows 版）

本教程适用于 Windows 版 Codex Desktop，通过一键脚本将界面切换为简体中文，操作简单，无需手动修改文件。

一、准备工作

1. 下载汉化包  
   已经有大佬在在github上提供了开源的汉化包，
   前往 Release 页面下载 codex-zh-CN-v0.1.2.zip 并解压到任意文件夹（例如 D:\codex-zh-CN）。  
   也可以直接克隆本仓库。这里汉化包放在了交流群里大家可以自取

2. 完全退出 Codex Desktop  
   在任务栏右下角 Codex 图标上右键 → 退出，确保进程彻底关闭（不要只关窗口）。

二、安装汉化

1. 以管理员身份运行 install-windows.bat（右键 → 以管理员身份运行，会弹出 UAC 授权提示，点击「是」）。

2. 等待环境检测完成，屏幕会显示交互菜单：

   [1] 安装汉化
   [2] 恢复英文 / 重置
   [3] 验证补丁结果
   [4] 重新检测环境
   [5] 手动指定 / 清除 Codex 安装路径
   [Q] 退出
   

3. 输入数字 1 并按回车，开始安装汉化。  
   ? 脚本会自动查找 Codex 安装目录（支持便携版和 Microsoft Store 版）。  

   ? 若未自动识别，可先选 [5] 手动指定路径。  

   ? 汉化过程中会备份原始文件，并自动重启 Codex。

4. 安装完成后，Codex 界面应自动显示为简体中文。




# Steam++ Start
127.0.0.1 huggingface.co
127.0.0.1 github.dev
127.0.0.1 api.github.com
127.0.0.1 github.githubassets.com
127.0.0.1 support-assets.githubassets.com
127.0.0.1 education.github.com
127.0.0.1 resources.github.com
127.0.0.1 uploads.github.com
127.0.0.1 archiveprogram.github.com
127.0.0.1 raw.github.com
127.0.0.1 githubusercontent.com
127.0.0.1 raw.githubusercontent.com
127.0.0.1 camo.githubusercontent.com
127.0.0.1 cloud.githubusercontent.com
127.0.0.1 avatars.githubusercontent.com
127.0.0.1 avatars0.githubusercontent.com
127.0.0.1 avatars1.githubusercontent.com
127.0.0.1 avatars2.githubusercontent.com
127.0.0.1 avatars3.githubusercontent.com
127.0.0.1 user-images.githubusercontent.com
127.0.0.1 objects.githubusercontent.com
127.0.0.1 private-user-images.githubusercontent.com
127.0.0.1 github.com
127.0.0.1 pages.github.com
127.0.0.1 gist.github.com
127.0.0.1 githubapp.com
127.0.0.1 hub.docker.com
127.0.0.1 greasyfork.org
127.0.0.1 update.greasyfork.org
127.0.0.1 github.io
#127.0.0.1 www.github.io
# Steam++ End
140.82.121.3 github.com
140.82.121.3 www.github.com
