# 来源、版本与复用边界

## img2threejs

- 仓库：https://github.com/img2threejs/img2threejs
- 固定提交：`0c0c49bc168e648dbaf9c8c080474de0b3a941b6`，SKILL 版本 2.0.1，Apache-2.0。
- 使用 Codex `skill-installer` 的 `install-skill-from-github.py --repo img2threejs/img2threejs --ref <上述提交> --path . --name img2threejs` 安装完整仓库。
- 位置：`C:\Users\Im1ssu\.codex\skills\img2threejs`。
- 已用现有 Python 3.12.13 验证 `forge/state.py init --help` 和 `forge/next.py --help` 正常返回，generic/character profile 可被枚举。
- 上游官方 npm CLI 暂不支持 Windows，本次未使用其符号链接安装器，也未更改全局 Python/PATH。后续脚本以 Python 绝对路径调用，系统的 python/python3 商店占位保持原状。
- 本轮已实际执行图片分析、规范、基础工厂生成、八阶段重建、浏览器多角度检查和修正。参考 OpenStax 前后表面解剖图（CC BY 3.0），详见 `modeling/模型重建报告.md`。本地修复了材质 pass gate 与其严格校验器的 textureless 路径不一致，记录于 `modeling/skill-compatibility.md`。未选择额外格式导出或领域插件。

## CardioSim 3D

- 仓库：https://github.com/SeraKah-1/cardiac-3d-ecg-simulator
- 固定提交：`109c9416b1c0e855b756ec00f86667882e4b7f0b`。
- 许可：MIT，原文保留在 `src/vendor/LICENSE`。
- 原始类型、LeadFieldModel 和 CardiacDipoleEngine 文件保留在 `src/vendor`。运行时复用 LeadFieldModel 的电极场、标准电位差及坐标转换。未采用其临床诊断规则、推断间期、教材文字、病例宣称或 UI。
- 新建调度器与分区贡献模型在 `src/engine.ts`。PR、QRS 等验证从生成的电压波形读取，未使用上游 `computeAnalyticalFeatures()` 的宣称值。
- 原始 checkout 留在 `vendor/cardiosim`，不参与构建。

## ECG / VCG 科学来源

- Clinical Methods, Electrocardiography：https://www.ncbi.nlm.nih.gov/books/NBK354/
- Bioelectromagnetism, chapter 16：https://bem.fi/book/16/16.htm
- ECGSIM 手册：https://www.ecgsim.org/manual/
- Kors et al., 1990：https://doi.org/10.1093/oxfordjournals.eurheartj.a059647
- Kors 系数交叉核对：研究团队的公开实现 https://github.com/Tereshchenkolab/Pacing_spike_removal_v2/blob/main/kors.m （仅核对矩阵数值，没有复制该文件或引入其依赖）。
- BRAVEHEART：https://github.com/BIVectors/BRAVEHEART 。已调查其 MATLAB/GPL 与 Windows 独立程序路线；本次未安装、未运行 BRAVEHEART，不能把本次数值核验称为已通过该软件验证。

## PTB-XL

- PTB-XL 1.0.3，Wagner et al., 2022：https://physionet.org/content/ptb-xl/1.0.3/ ，DOI：10.13026/kfzx-aw45。
- 原始论文：Wagner et al., 2020, Scientific Data：https://doi.org/10.1038/s41597-020-0495-6 。
- 数据许可 CC BY 4.0，完整许可位于 `public/data/LICENSE-PTBXL.txt`。
- 仅使用四条公开、去标识化记录；没有导入用户患者资料。重建 VCG 属于派生结果，在界面中明确标注。

