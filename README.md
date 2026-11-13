# 心向 · 中文三维心电向量学习台

从电偶出发，学习十二导联、额面与水平面投影、三维向量心电图及常见诊断学病例。React、TypeScript、Three.js；支持安装到 iPad 主屏幕并离线使用。

目前在线版：https://xinxiang-ecg-learning-ipad.beichendu322.chatgpt.site/

本仓库是用户自己的源码备份。可从 [Releases](https://github.com/SarkazCollegeWisadel/xinxiang-ecg-learning/releases) 下载已构建的 iPad 网页包。ZIP 用于静态部署和备份；iPad 使用 HTTPS 网址添加到主屏幕。

## 功能

- 50 个命名心脏外表部件；旋转、缩放、点选、拆解、胸廓定位和透明传导路径。
- 同步的十二导联、三维 VCG 及额面、水平面、矢状面投影；暂停、慢放、逐帧和时间轴。
- 五步课程、54 个参数化病例和正常变异；电偶、导联场、Wilson 中心端、正常对照与电极位移实验。
- 四条公开 PTB-XL 记录（#1、#172、#30、#257），明确标注的 Kors 重建向量环。
- 生产构建包含离线缓存和主屏幕图标；首次联网缓存完成后可断网打开。系统清理缓存后需重新联网。

## 构建与运行

使用 Node.js 22.12+：

```sh
npm ci
npm run build
node server.mjs
```

访问 `http://127.0.0.1:5186`。Windows 可以在构建后双击 `Start.cmd`。

`dist/` 可部署到 HTTPS 静态托管，支持仓库子路径。`npm run build` 会准备最小模型运行规范、检查 TypeScript、构建网页并生成版本化离线缓存。日常构建和运行不需要 Python、外部 AI、患者数据或密钥。

## iPad

Safari 打开 HTTPS 网页后，分享 → 添加到主屏幕。从主屏幕首次联网打开，在左上目录底部等待“离线资料已就绪”，之后可断网学习。详见 [iPad 使用说明](packaging/iPad使用说明.md)。

## 验证

```sh
npm test
npm run test:browser
node packaging/check-ipad.mjs
```

数值测试不需要浏览器。浏览器测试需要服务启动和可用的 Playwright 浏览器；原配置使用本机 Chrome，可按自己的环境修改路径。WebKit 检查需先运行 `npx playwright install webkit`，它模拟 iPad，不能替代真机验收。

## 模型与来源

心脏外表由 OpenStax 解剖插图指导，经 img2threejs 2.0.1 基础工厂和手工曲面修形生成；冠脉及比例为图谱式教学近似。传导路径是示意；电生理采用参数化电偶，未求解完整组织传播。病例没有心电专科逐例临床验证。

- [CardioSim](https://github.com/SeraKah-1/cardiac-3d-ecg-simulator)：复用导联场及坐标转换，MIT；原许可保留在 `src/vendor/LICENSE`。
- [OpenStax 图谱](https://commons.wikimedia.org/wiki/File:2005_Surface_Anatomy_of_the_Heart.jpg)：CC BY 3.0，参考图及归属在 `modeling/references/`。
- [img2threejs](https://github.com/img2threejs/img2threejs)：Apache-2.0；工具为外部建模依赖，不是日常网页运行依赖。
- [PTB-XL 1.0.3](https://physionet.org/content/ptb-xl/1.0.3/)：CC BY 4.0，记录、头文件、许可和来源编号保留在 `public/data/`。
- [Kors et al.](https://doi.org/10.1093/oxfordjournals.eurheartj.a059647)：真实 ECG 的 VCG 为回归重建结果。

第三方软件许可集中在 `public/licenses/`。本仓库不包含账号凭据、本机浏览器资料或用户学习笔记。建模审阅规范包含历史证据路径；详细图片审阅产物保留在本机，不属于网页运行依赖。

