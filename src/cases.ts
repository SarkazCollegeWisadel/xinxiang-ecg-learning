export type Rhythm = 'sinus'|'sinusIrregular'|'pause'|'saBlock'|'pac'|'pjc'|'pvc'|'svt'|'flutter'|'af'|'vt'|'vflutter'|'vf'|'junctionEscape'|'ventEscape'|'av1'|'wenckebach'|'mobitz2'|'av3';
export interface Case {
  id:string; name:string; en:string; group:string; mechanism:string; expected:string; pitfall:string;
  rhythm?:Rhythm; hr?:number; axis?:number; chamber?:'la'|'ra'|'lv'|'rv'|'atrialDelay';
  conduction?:'rbbb'|'lbbb'|'lafb'|'lpfb'|'wpw'; injury?:'anterior'|'inferior'|'lateral'|'posterior'|'right'|'ischemia'|'pericarditis'|'early'|'digitalis';
  stage?:'acute'|'evolving'|'old'; electrolyte?:'highK'|'lowK'|'highCa'|'lowCa'|'longQT'; misplaced?:boolean;
}
const c=(id:string,name:string,en:string,group:string,mechanism:string,expected:string,pitfall:string,extra:Partial<Case>={}):Case=>({id,name,en,group,mechanism,expected,pitfall,...extra});
export const cases:Case[]=[
 c('normal','正常窦性心律','Normal sinus rhythm','基础与变异','先有心房除极，经房室结延迟后，室间隔、心室主体与基底部依次贡献；不同方向的贡献随时间相加。','P 波先于 QRS；QRS 环快速展开，T 环较缓慢。','向量朝正电极可产生正向贡献；但记录值还取决于参考端及导联场。'),
 c('lad','电轴左偏','Left axis deviation','基础与变异','把心室合成向量向左上旋转，比较额面 I、II、aVF 的代数和。','I 主波向上，aVF 主波向下；II 有助于区分轻度左偏与左轴偏移。','心脏解剖位置、电轴、室间传导改变并不等价。',{axis:-85}),
 c('rad','电轴右偏','Right axis deviation','基础与变异','将心室合成向量向右下旋转，保留时间顺序，单独观察空间方向。','I 主波转负，aVF 主波保持正向。','电轴右偏本身不能直接等同于右室肥大。',{axis:85}),
 c('placement','胸前电极错位','Precordial misplacement','基础与变异','将 V1、V2 向上移动；相同心脏向量通过新的导联场产生不同记录。','V1、V2 的振幅和形态改变，肢体导联保持不变。','电极错位可能模拟异常；此例只是几何效应，不代表任意错位都出现同一形态。',{misplaced:true}),
 c('la','左心房扩大','Left atrial enlargement','心房与心室','左房有效贡献增大、时间延后，右房与左房两部分在时间上分离。','P 波增宽、双峰倾向；V1 的终末负向贡献增加。','双峰或宽 P 波并非左房解剖增大的充分证据。',{chamber:'la'}),
 c('ra','右心房扩大','Right atrial enlargement','心房与心室','增加偏向下方的早期右房贡献，观察下壁导联的投影。','下壁导联 P 波较高尖。','P 波电压也受方向、位置和导联场影响。',{chamber:'ra'}),
 c('atrialDelay','房内传导延迟','Interatrial conduction delay','心房与心室','保持左房贡献大小，将左房激动推迟，与左房扩大作对照。','P 波增宽、切迹；空间幅度不必同步增大。','形态相似不等于机制相同：路程变长与传导变慢需要分别理解。',{chamber:'atrialDelay'}),
 c('lvh','左心室肥大伴劳损','LVH with strain','心房与心室','增加左室方向的有效除极贡献，并加入相反方向的继发性复极改变。','左胸导联 R 增高、右胸 S 加深；侧壁 ST-T 与主 QRS 不一致。','本例展示机制，不以固定电压阈值证明解剖肥大。',{chamber:'lv'}),
 c('rvh','右心室肥大','Right ventricular hypertrophy','心房与心室','增加向右前方的右室贡献，改变左右室贡献的平衡。','V1 正向贡献增加，额面合成向量右移。','V1 高 R 也可见于后壁梗死、预激等，需结合其余导联。',{chamber:'rv'}),
 c('av1','一度房室阻滞','First-degree AV block','传导异常','保持每个 P 后均有 QRS，只延长房室传导延迟。','逐搏实测 PR 延长，P 与 QRS 仍为 1:1。','PR 是 P 起点到 QRS 起点，不是 P 终点到 QRS。',{rhythm:'av1'}),
 c('wenckebach','二度Ⅰ型房室阻滞','Mobitz I / Wenckebach','传导异常','心房按固定节律激动，PR 逐次延长，随后一次心房激动不下传。','PR 渐长后出现 P 后 QRS 脱落，之后重复。','必须看连续多个心搏，单个向量环不能显示房室传导比例。',{rhythm:'wenckebach'}),
 c('mobitz2','二度Ⅱ型房室阻滞','Mobitz II','传导异常','在已下传心搏中保持 PR 恒定，周期性不产生对应心室激动。','固定 PR 与间歇性 QRS 脱落。','这是固定比例教学例，真实传导比例可变化。',{rhythm:'mobitz2'}),
 c('av3','三度房室阻滞','Complete AV block','传导异常','心房与心室使用独立时钟，慢的心室逸搏维持心室激动。','P 与 QRS 各自规律，PR 关系不断变化。','完全阻滞不能用一个固定的超长 PR 表示。',{rhythm:'av3',hr:35}),
 c('rbbb','右束支传导阻滞','RBBB','传导异常','左室按原路径激动，右室终末激动延迟，出现向右前方的晚期贡献。','QRS 增宽，V1 终末 R′，侧壁出现终末 S。','环的终末部分比整体旋转更能解释束支阻滞。',{conduction:'rbbb'}),
 c('lbbb','左束支传导阻滞','LBBB','传导异常','间隔初始激动方向改变，左室经较慢路径激动，主体贡献延后、延长。','宽 QRS、侧壁宽大 R，右胸负向主波及继发性 ST-T 改变。','不要把单纯左偏等同于左束支阻滞。',{conduction:'lbbb'}),
 c('lafb','左前分支阻滞','LAFB','传导异常','以左后分支先激动的分区顺序，形成偏左上的中晚期合成向量。','左上电轴；下壁偏负，I、aVL 偏正。','本例是定性机制示例，临床判定还需完整形态与排除条件。',{conduction:'lafb',axis:-95}),
 c('lpfb','左后分支阻滞','LPFB','传导异常','改变左室分区激动顺序，使主要向量偏右下方。','右轴偏移及相应的肢体导联改变。','孤立左后分支阻滞较少见，需要排除其他右偏原因。',{conduction:'lpfb',axis:85}),
 c('wpw','预激图形','Ventricular pre-excitation','传导异常','旁路提前激动一部分心室，先产生低速斜坡贡献，再叠加正常传导贡献。','短 PR、QRS 起始顿挫的 delta 波、QRS 增宽。','delta 的极性取决于旁路位置；此例仅为一种方向。',{conduction:'wpw'}),
 c('tachy','窦性心动过速','Sinus tachycardia','心律失常','缩短窦性周期，仍保留有序 P–QRS 关系。','心率快、每搏仍有窦性 P。','快速节律不自动等于室上性阵发性心动过速。',{hr:115}),
 c('brady','窦性心动过缓','Sinus bradycardia','心律失常','延长窦性周期，保持房室顺序。','心率慢，P 与 QRS 仍有固定关系。','需结合症状及背景判断，不能仅凭慢心率诊断疾病。',{hr:45}),
 c('sinusIrregular','窦性心律不齐','Sinus arrhythmia','心律失常','窦性周期随缓慢节律改变，P 波形态保持一致。','PP、RR 缓慢变化，正常房室关系保留。','与房颤的无规律 RR、缺乏一致 P 波区别。',{rhythm:'sinusIrregular'}),
 c('pause','窦性停搏','Sinus pause','心律失常','在连续窦性激动中插入一次非整数倍的停顿。','P 与 QRS 同时缺失，随后恢复。','本例展示非整数倍长间歇；实际需长时间记录及鉴别。',{rhythm:'pause'}),
 c('saBlock','窦房传导阻滞','Sinoatrial exit block','心律失常','内部窦性时钟继续，但一次激动未传至心房。','间歇约为基础 PP 的整数倍。','只展示二度Ⅱ型机制；不是全部窦房阻滞形式。',{rhythm:'saBlock'}),
 c('pac','房性期前收缩','PAC','心律失常','一次心房激动提前、方向改变，再经房室结下传。','提前异形 P，通常窄 QRS，随后节律重整。','P 可叠在上一搏 T 波；本例选取容易观察的时序。',{rhythm:'pac'}),
 c('pjc','交界性期前收缩','PJC','心律失常','一次提前的交界性激动，心室经正常系统下传，心房可逆行激动。','提前窄 QRS，短 PR 的逆行 P。','逆行 P 也可位于 QRS 内或后方，本例展示其一种关系。',{rhythm:'pjc'}),
 c('pvc','室性期前收缩','PVC','心律失常','一次心室异位起搏绕过正常快速传导路径，除极展宽且方向改变。','提前宽大 QRS、无先行 P、继发性反向 T及代偿间歇。','不同起源的室早形态不同；本例采用单一起源。',{rhythm:'pvc'}),
 c('svt','室上性心动过速','SVT','心律失常','以规则快速心室下传展示窄 QRS 快速节律，P 埋入或接近 QRS。','规则快速窄 QRS，独立 P 不易辨认。','未模拟具体折返环路；不能据本例区分 AVNRT 与 AVRT。',{rhythm:'svt',hr:180}),
 c('flutter','心房扑动，2:1 下传','Atrial flutter','心律失常','持续快速心房活动，约每两次心房活动下传一次。','连续 F 波及约 150 次/分的心室率。','锯齿形态与极性随扑动类型、导联变化。',{rhythm:'flutter',hr:150}),
 c('af','心房颤动','Atrial fibrillation','心律失常','移除有序 P，叠加低幅连续房性活动，并使用不规则心室下传时刻。','无一致 P 波，RR 绝对不齐。','显示连续时间窗，不将房颤强制包装成重复的单搏向量环。',{rhythm:'af',hr:100}),
 c('vt','室性心动过速','Ventricular tachycardia','心律失常','连续快速心室异位激动，采用宽而异常定向的心室除极路径。','规则宽 QRS 快速节律、复极不一致。','真实宽 QRS 心动过速的鉴别需要更多证据。',{rhythm:'vt',hr:155}),
 c('vflutter','心室扑动','Ventricular flutter','心律失常','以快速连续、近正弦的心室合成活动展示严重无序前的连续状态。','QRS 与 T 难以分开，呈连续大幅振荡。','这是一种教学信号表示，不模拟完整旋转波组织动力学。',{rhythm:'vflutter'}),
 c('vf','心室颤动','Ventricular fibrillation','心律失常','多个不同频率和方向的活动同时叠加，无有序心室除极序列。','无可辨认的重复 QRS，连续不规则向量轨迹。','这是参数化连续轨迹，不能按正常单搏环解释。',{rhythm:'vf'}),
 c('junctionEscape','交界性逸搏心律','Junctional escape rhythm','心律失常','较慢交界性时钟接管心室激动，保留正常心室传导。','慢而规则的窄 QRS，逆行或不明显 P。','与提前出现的交界性期前收缩按出现时间区分。',{rhythm:'junctionEscape',hr:45}),
 c('ventEscape','室性逸搏与逸搏心律','Ventricular escape rhythm','心律失常','停顿后慢的心室时钟接管，显示首个延迟逸搏及后续逸搏心律。','长间歇后出现宽 QRS，随后约 35 次/分。','逸搏是延迟出现；室早是提前出现。',{rhythm:'ventEscape',hr:35}),
 c('ischemia','缺血性 ST-T 改变','Ischemic ST-T changes','缺血与梗死','改变复极贡献及 ST 期间的电位差，观察侧壁导联与对向导联。','侧壁 ST 压低、T 倒置的示例。','ST-T 改变不专属于缺血，不用于单凭图形判断病因。',{injury:'ischemia'}),
 ...(['anterior','inferior','lateral'] as const).flatMap((territory,i)=>[
   c('mi-'+territory,['前壁','下壁','侧壁'][i]+'梗死：急性期','Acute '+territory+' MI','缺血与梗死','病变方向的损伤贡献作用于 ST 段，叠加早期除极贡献丢失。','对应导联 ST 抬高与对向改变；观察初始 QRS。','ST、Q、T 的组合随时间和个体变化；梗死并不必然出现 Q 波。',{injury:territory,stage:'acute'}),
   c('mi-'+territory+'-evolving',['前壁','下壁','侧壁'][i]+'梗死：演变期','Evolving '+territory+' MI','缺血与梗死','减弱 ST 损伤贡献，增加异常复极并保留除极贡献缺失。','ST 回落、T 倒置及 QRS 改变。','教学时间轴是典型演变示意，不预测患者的具体时间进程。',{injury:territory,stage:'evolving'}),
   c('mi-'+territory+'-old',['前壁','下壁','侧壁'][i]+'梗死：陈旧期 / Q 波','Old '+territory+' MI','缺血与梗死','保留初始除极贡献缺失，关闭急性 ST 损伤贡献。','病理性 Q / R 波减低的机制示意，ST 接近基线。','Q 波不是瘢痕的充分必要条件；不可把梗死简化为整片无电压。',{injury:territory,stage:'old'})
 ]),
 c('posterior','后壁受累','Posterior involvement','缺血与梗死','把损伤向量指向后方，观察前胸导联的镜像改变，并计算 V7–V9。','前胸 ST 压低，后壁补充导联可见正向 ST。','后壁受累需要补充导联及临床证据。',{injury:'posterior',stage:'acute'}),
 c('rightMI','右室受累','Right ventricular involvement','缺血与梗死','把损伤贡献指向右前方，同时观察 V3R、V4R。','右胸补充导联产生正向 ST 投影。','十二导联对右室受累的呈现有限，需及时记录右胸导联。',{injury:'right',stage:'acute'}),
 c('highK','高钾血症','Hyperkalemia','电解质与鉴别','增加并收窄 T 贡献、削弱 P，严重示例伴除极展宽。','高尖 T、P 减小、QRS 展宽。','血钾与形态并非一一对应；滑块不是血钾浓度计算器。',{electrolyte:'highK'}),
 c('lowK','低钾血症','Hypokalemia','电解质与鉴别','降低 T 贡献，加入明显的晚期 U 贡献与 ST 改变。','低平 T、明显 U 波及 ST 压低倾向。','U 波机制尚无单一定论；QU 延长与 QT 延长需要区分。',{electrolyte:'lowK'}),
 c('highCa','高钙血症','Hypercalcemia','电解质与鉴别','缩短 ST 期间的时长，使 T 提前。','QT 缩短，以 ST 缩短为主。','电解质异常需实验室证实。',{electrolyte:'highCa'}),
 c('lowCa','低钙血症','Hypocalcemia','电解质与鉴别','延长 ST 时间，使 T 推迟。','QT 延长，以 ST 延长为主。','不要把低钙导致的长 QT 与所有长 QT 病因等同。',{electrolyte:'lowCa'}),
 c('longQT','长 QT 图形','Long QT pattern','电解质与鉴别','延迟复极贡献结束时刻，保持除极时序。','从实际波形观察 QT 延长。','本例未模拟离子通道，不据此预测尖端扭转风险。',{electrolyte:'longQT',hr:60}),
 c('digitalis','洋地黄效应','Digitalis effect','电解质与鉴别','加入缓慢变化的负向 ST 贡献，并缩短复极时程。','侧壁下斜、凹陷的 ST 改变示例。','洋地黄效应不等同于中毒。',{injury:'digitalis'}),
 c('pericarditis','心包炎型 ST 改变','Pericarditis pattern','电解质与鉴别','设置向左下前的 ST 贡献，在多导联产生同向变化，并示意 PR 偏移。','多导联 ST 抬高，aVR 对向，部分导联 PR 压低。','这是分布近似；真实弥漫性炎症不能由单个电偶完整表达。',{injury:'pericarditis'}),
 c('early','早期复极图形','Early repolarization','电解质与鉴别','在前外侧方向加入较小的 J 点及早期 ST 贡献，保留正常激动顺序。','J 点、ST 的轻度正向改变。','仅靠 ST 外形不能排除急性缺血。',{injury:'early'})
];
export const groups=[...new Set(cases.map(c=>c.group))];
export const sources=[
 {title:'Clinical Methods · Electrocardiography（电生理基础）',url:'https://www.ncbi.nlm.nih.gov/books/NBK354/'},
 {title:'Bioelectromagnetism · Vectorcardiographic Lead Systems',url:'https://bem.fi/book/16/16.htm'},
 {title:'ECGSIM 手册（正向模型与局限）',url:'https://www.ecgsim.org/manual/'},
 {title:'Kors 等，1990 · 从标准导联重建 Frank VCG',url:'https://doi.org/10.1093/oxfordjournals.eurheartj.a059647'},
 {title:'PTB-XL 1.0.3 · 真实十二导联记录与许可',url:'https://physionet.org/content/ptb-xl/1.0.3/'},
 {title:'CardioSim 3D · MIT 开源导联场底座',url:'https://github.com/SeraKah-1/cardiac-3d-ecg-simulator'},
];
