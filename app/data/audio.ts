export type AudioCategory = string;

export type AudioTrack = {
  id: string;
  category: AudioCategory;
  title: string;
  kicker: string;
  source: string;
  duration: string;
  description: string;
  text: string;
  audioUrl?: string;
  seriesId?: string;
  seriesTitle?: string;
  seriesLabel?: string;
  seriesColor?: string;
  seriesIcon?: string;
  sortOrder?: number;
};

export const audioTracks: AudioTrack[] = [
  {
    id: "july-flood-resilience",
    category: "current",
    title: "七月热点：防汛抗旱与基层韧性",
    kicker: "月度热点",
    source: "人民日报要点整理",
    duration: "6分钟",
    description: "从风险预警、力量下沉到科技赋能，积累一组可用于申论的治理框架。",
    audioUrl: "/audio/july-flood-resilience.wav",
    text: "本期月度热点，关注防汛抗旱与基层治理韧性。六月三十日召开的中共中央政治局会议，对防汛抗旱工作作出部署，强调树牢底线思维和极限思维，立足防大汛、抗大旱、防强台风。理解这一热点，可以抓住三层逻辑。第一，关口前移。治理不能只在灾害发生后抢险，更要把风险普查、监测预警和预案演练做在前面。第二，力量下沉。县、乡、村处在防灾减灾第一线，需要明确预警叫应、人员转移、物资保障等责任链条，让信息和资源真正抵达基层。第三，科技赋能。用好风险地图、智能装备和精准预报，把技术优势转化为基层可操作的行动方案。申论表达可以这样概括：以时时放心不下的责任感筑牢安全底线，以事事落实到位的执行力守护群众安宁。答题时既要写制度建设，也要写群众参与和基层能力，形成预防、响应、恢复的完整闭环。",
  },
  {
    id: "politburo-june-30",
    category: "current",
    title: "重要会议：防汛抗旱部署听要点",
    kicker: "重要会议",
    source: "会议精神学习",
    duration: "5分钟",
    description: "用“认识—措施—责任”三步法，快速记住会议类时政材料。",
    audioUrl: "/audio/politburo-june-30.wav",
    text: "重要会议类材料，建议用认识、措施、责任三步法记忆。认识层面，要看到汛情旱情影响群众生命财产安全，也关系经济社会平稳运行，必须坚持人民至上、生命至上。措施层面，要加强监测预报预警，突出重点地区和薄弱环节，提前预置抢险力量和救灾物资，果断转移危险区域群众。责任层面，要压实各级责任，加强统筹协调和值班值守，确保指令畅通、响应迅速。考试遇到应急治理题，可以把会议要求转化成四个答题关键词：预警更精准、预案更具体、资源更下沉、责任更闭环。最后记住一句规范表达：宁可十防九空，不可失防万一，以工作的确定性应对风险的不确定性。",
  },
  {
    id: "cybersecurity-law-2026",
    category: "current",
    title: "新法解读：修改后的网络安全法",
    kicker: "新法解读",
    source: "中国人大网要点整理",
    duration: "7分钟",
    description: "记住施行时间、治理对象和法治意义，适配常识判断与申论素材。",
    audioUrl: "/audio/cybersecurity-law-2026.wav",
    text: "本期新法解读，关注修改后的网络安全法。全国人大常委会关于修改网络安全法的决定，自二零二六年一月一日起施行。备考时不必孤立背条文，可以建立三点认识。第一，网络空间不是法外之地，网络运营、数据处理和安全保护都应在法治轨道上运行。第二，安全与发展不是二选一，要通过清晰规则稳定预期，让技术创新在安全边界内释放活力。第三，责任必须与风险相匹配，既压实主体责任，也强化监管协同和违法惩戒。常识题要重点记住法律名称和施行时间。申论题则可以使用这样的表达：以制度之治夯实数字之基，以法治确定性增强发展可预期性，推动形成权责清晰、保护有力、协同高效的网络治理格局。",
  },
  {
    id: "people-commentary-governance",
    category: "essay",
    title: "评论晨读：警力沉下去，效能提上来",
    kicker: "人民日报评论拆解",
    source: "人民日报主题学习",
    duration: "6分钟",
    description: "不照抄原文，拆解“服务下沉—多元共治—源头预防”的论证结构。",
    audioUrl: "/audio/people-commentary-governance.wav",
    text: "今天的评论晨读，主题是基层治理中的力量下沉。治理效能从哪里来？首先来自服务触角向基层延伸。群众诉求往往具体而细小，却直接关系获得感。把工作阵地前移，才能及时发现问题、快速回应需求。其次来自多元力量有序参与。基层治理不是单打独斗，要完善警社联动、群防群治和专业协同机制，把群众智慧转化为治理资源。再次来自治理方式由被动处置转向主动预防。通过信息共享、风险研判和矛盾前端化解，把问题解决在萌芽状态。可以积累这组规范表达：推动治理重心下移、资源下沉、保障下倾；以服务温度提升治理精度，以协同力度增强平安厚度；打通服务群众的最后一公里，织密基层治理的防护网。",
  },
  {
    id: "standard-expression-list",
    category: "essay",
    title: "规范表达：基层治理高频词组",
    kicker: "申论晨读",
    source: "日练原创整理",
    duration: "5分钟",
    description: "十组可直接迁移到概括题、对策题和大作文的规范表达。",
    audioUrl: "/audio/standard-expression-list.wav",
    text: "基层治理主题规范表达，开始跟读。第一，坚持党建引领，凝聚治理合力。第二，推动治理重心下移、资源下沉、服务下倾。第三，畅通民意表达渠道，及时回应群众关切。第四，完善共建共治共享的社会治理制度。第五，用好数字技术，提升治理的精细化、智能化水平。第六，明确权责边界，持续为基层减负赋能。第七，坚持和发展新时代枫桥经验，把矛盾化解在基层。第八，强化源头治理，实现从被动处置向主动预防转变。第九，以群众满意度检验治理成色。第十，把制度优势转化为治理效能。建议暂停后复述，再选择三组写进自己的素材本。",
  },
  {
    id: "disaster-prevention-quotes",
    category: "essay",
    title: "分主题金句：防灾减灾与安全治理",
    kicker: "金句合集",
    source: "日练原创整理",
    duration: "4分钟",
    description: "适合通勤反复磨耳朵，形成安全治理主题的表达肌肉记忆。",
    audioUrl: "/audio/disaster-prevention-quotes.wav",
    text: "防灾减灾主题金句，开始积累。安全是发展的前提，发展是安全的保障。防范胜于救灾，责任重于泰山。把风险想在前，把预案做在前，把力量摆在前。基层强则安全根基稳，基础实则治理韧性足。既要提升监测预警的精准度，也要增强应急响应的行动力。用大概率思维应对小概率事件，以工作的确定性应对风险的不确定性。让每一次预警都有人响应，让每一项责任都落到末梢。守住安全底线，才能托起群众稳稳的幸福。",
  },
];
