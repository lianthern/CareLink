# 逐镜头制作表
计划成片 124.5 秒，共 36 段，其中 19 段为 H3 连续动作。时长是剪辑计划，不是已生成结果。
各镜头独立保存；不要把整个文档一次塞进视频生成模型。SHOTS.json 的 prompt 是逐镜头正文，空间段由合成控制。

## H01 · 父亲拍：跑向奶奶
0—4 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Wide view from the father southwest of the dining table, camera height 1.45m, moderate 28mm equivalent field of view. The three-year-old boy in a cream T-shirt and pale blue denim short overalls starts near the green sofa on frame left. He takes three small quick steps toward the table on frame right and stops standing at its south edge. His right hand starts reaching toward a small cookie saucer beside the blue-and-white tin. Grandmother in a pink cardigan stays seated beyond the table. Mother in an ivory blouse stays seated beside her holding a smartphone. Gently pan right with the boy, keeping his feet and table edge visible. End before he touches a cookie.

衔接：H02 starts with the same empty right hand continuing its reach; the boy is still standing.

检查：从沙发侧走向桌边，而不是已经坐桌旁；右手未拿到饼干；母亲在桌边拍、父亲为画外机位；奶奶/家具/衣物与H02一致。

## H02 · 母亲拍：推碟、拿到、笑
4—8 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A closer three-quarter view from the mother seated beside grandmother at the same table, camera height 1.10m, 35mm equivalent field of view. The same boy remains standing on the floor at the south edge of the same wooden table. His empty right hand continues reaching. Grandmother slides the small saucer about fifteen centimeters toward him with her right hand. He takes exactly one cookie with his right hand and looks up at grandmother with a relieved small smile. Hold the smile briefly. Keep the blue-and-white tin stationary. Keep enough lower body and table edge visible to make his standing posture unambiguous. Mother is behind this camera and is not visible. Single steady take.

衔接：Match empty right hand and table contact from H01; do not replay the run or use seated cookie-b as first frame.

检查：全程站立；先推碟后拿到，动作单次；仅一块饼干到右手；不用旧cookie-b姿势。

## H03 · 收回母亲记录，显出父亲记录
8—11 秒；controlled_spatial_composite。
H02最后约0.25秒自然停为封面；出现细照片边界。相机从母亲拍摄位置沿室内通路退开1.2m，照片固定在桌侧缩至屏宽6%。西南客厅侧显出H01封面，短暂显示“妈妈的记录 / 爸爸的记录”。声音接AI第一句。

检查：两张封面来自真实生成片段；只退到家内部；家具视差和遮挡成立。

## H04 · 从餐桌漫游到小院入口
11—14 秒；controlled_spatial_composite。
在空的同一室内从桌侧绕到客厅通小院的门边，至少另见门厅、厨房、小院三个小入口。各卡随距离和角度改变大小，走近雨天记录。

检查：不是横向贴屏卡片队列；旧两张仍留原位；不出现多个年龄男主。

## H05 · 点开雨天照片
14—15.5 秒；controlled_spatial_composite。
雨天缩略图边缘轻亮一次，相机对齐、照片扩至全画面；雨声先进入，最后边框消失接H06。

检查：从小卡开始；扩大有透视衔接。

## H06 · 雨天：去帮母亲收衣服
15.5—19.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A wide smartphone view from just inside the glass doorway looking into the family courtyard during a light summer shower. The same boy, now six years old, wears a cream striped shirt and dark shorts. He carries a small empty laundry basin with both hands and walks from the foreground doorway toward his mother at the clothesline. Mother remains beside the line and lifts one towel off it. Wet stone paving and the familiar tree remain fixed. A small forward camera lean follows his arrival. End with him stopping beside her, basin at waist height, before the towel falls. Natural rain and hurried footsteps.

衔接：H07 continues after he has arrived; no second walk from the door.

检查：院子属于同一家；母亲在收衣、父亲在门边拍；小孩两手抱盆，不凭空出现第二个人。

## H07 · 雨天：毛巾盖住脸
19.5—23.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A closer view from the same doorway side of the courtyard action, still on the same side of the mother-child axis. The six-year-old boy is already standing beside mother holding the laundry basin at waist height. Mother lowers the towel she just removed; its near edge flops lightly over the boy's forehead and eyes. He frees his right hand, lifts the towel off his face, then laughs while mother smiles. His left arm supports the basin throughout. Keep the towel soft and gravity-driven, not floating. Camera stays nearly still. End on their shared smile with the boy's face visible.

衔接：衣服开始尚未盖住脸；承接H06取下毛巾后的状态。

检查：动作因果清楚；盆不漂浮；没有第三摄影者无故出现。

## H08 · 院中记录收回，走向门厅
23.5—26.5 秒；controlled_spatial_composite。
H07收回小院照片，H06记录相邻。相机在同一室内经过客厅转到门厅，雨声渐弱。门厅上学前缩略图成为目标。

检查：院内到门厅有通路；禁止整家又变玩具模型。

## H09 · 点开第一次上学前的照片
26.5—28 秒；controlled_spatial_composite。
门厅小卡对齐展开；晨光与拉书包带声音引入H10。

检查：小→大→人物开始动作。

## H10 · 出门前：调整书包带
28—32 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Medium-wide smartphone view inside the front hallway on a bright morning. The boy is now seven, with the approved childhood face, a white short-sleeved shirt, dark navy shorts and a grey-green backpack. His mother in an ivory top crouches in front of him and tightens the left shoulder strap once. Grandmother with grey short curls and pink cardigan stands beside them holding a small paper packet of cookies. The open front doorway and the edge of the dining room establish the same home. Father films from the living-room side; he is not in frame. The boy shifts his shoulders to feel the adjusted straps. End as mother finishes and grandmother begins moving the packet toward the side pocket.

衔接：H11承接书包已调整好，奶奶才开始放饼干。

检查：母亲与奶奶是两人；书包颜色和校门段一致；不使用旧图把奶奶当母亲。

## H11 · 出门前：奶奶放进一包饼干
32—36 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Closer smartphone view from the same living-room side of the front-hall axis. The seven-year-old boy remains standing in the white shirt, navy shorts and grey-green backpack with adjusted straps. Grandmother places the small cookie packet into the backpack side pocket. Mother has just finished helping and stays beside them. The boy turns his head to grandmother, smiles, then takes one step toward the open front door. Camera pans just enough to retain his shoulder, pocket and grandmother's hand. The packet stays in the pocket after her hand withdraws. End on his first outward step, not a new goodbye sequence.

衔接：S02 later begins the same school morning with the identical outfit and backpack.

检查：饼干包进同一侧袋；同日衣着一致；不是传送到学校。

## H12 · 完整家退远，横滑换校园
36—42 秒；controlled_spatial_composite。
先H11收回门厅照片，再升高退远露出完整家和平面关系；至少6个照片入口随房屋整体缩小。整个家向左滑出，校园从右进入。不是黑底悬浮屋，不出现大量同时活动的男主。

检查：这是家章第一次整体退远；所有卡跟场所一同运动；方向始终左移。

## S01 · 进入校园与校门照片
42—45 秒；controlled_spatial_composite。
从校园总览下降到校门内外的人尺度。教学楼、连廊、操场与树下入口可见空间联系，靠近校门外小卡并展开接S02。

检查：校园不只是一张航拍图；校门照片锚点准确。

## S02 · 入学：母亲拍到回头挥手
45—49 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Smartphone view from outside the school gate, camera at the mother's chest height, wide enough to include the gateposts and the teaching block beyond. The same seven-year-old boy in a white shirt, navy shorts and grey-green backpack walks through the gate away from camera. He glances over his shoulder once and briefly waves his empty right hand to his mother. He then lowers his hand and begins turning forward. Other children enter calmly without obscuring him. The camera follows with a gentle pan only. End as his shoulders turn toward the school; do not keep him waving throughout.

衔接：S03从挥手结束、转身继续进校开始，不能重演挥手。

检查：同出门前衣着和包；门柱/楼/树方位一致；挥手只有一次。

## S03 · 入学：另一位家长留下门内记录
49—53 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. An inside-the-gate smartphone view from another parent, three-quarter rear-side of the entering children. The same seven-year-old boy has finished his wave and now faces into the campus. His right hand is down. A child beside him falls into step and they walk forward together toward the teaching building, away from the entrance. Keep the same gate, tree-lined path, morning light and grey-green backpack. Use a stable medium-wide shot with a small follow pan, preserving the destination on screen right. The mother remains behind near the gate and does not teleport ahead. End with the children walking comfortably together.

衔接：只承接往前走；可用门柱中性遮挡解决角度方向，不能水平镜像。

检查：不二次挥手；同一校门内侧；另一来源带来完整事件后半段。

## S04 · 校门两份记录收回，穿过连廊
53—56 秒；controlled_spatial_composite。
S03收回门内小卡，与门外S02同时呈现；沿校门路径进入教学楼连廊的人尺度相机，经过有教室门窗和操场可见面的区域。

检查：校门→教学楼连续关系可理解；两份记录不消失。

## S05 · 教室内选中十七岁记录
56—57.5 秒；controlled_spatial_composite。
相机通过教室门/窗口进入正确教室一侧，选中课桌附近小照片，展开接S06。

检查：不是对航拍图再次放大；课桌和黑板关系明确。

## S06 · 课堂：找不到橡皮
57.5—61.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. An ordinary classroom in the established campus, soft daylight from the courtyard-side windows, green chalkboard at the front, wooden desks in rows. Medium smartphone view from a seated classmate behind and to the boy's left, camera height 1.1m. The protagonist is now seventeen, wearing a white school shirt and dark trousers, with the approved teenage face. He quietly opens his pencil case and searches with one hand, then looks toward the girl at the adjacent desk on his right. The girl has a black ponytail and the same white school uniform; freeze this face for graduation, wedding and old age. End on his small questioning glance before any eraser changes hands. Keep the camera still and avoid legible board text.

衔接：S07女生在同侧邻桌，男主伸手发生在本镜寻找之后。

检查：真正教室内部而非走廊当课堂；固定女孩脸型和座位；橡皮尚未交付。

## S07 · 课堂：邻桌推过一块橡皮
61.5—65.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A closer classroom smartphone view from a classmate across the aisle, staying on the same side of the two students' axis. The seventeen-year-old boy and ponytailed girl retain their exact faces, uniform and adjacent desks from the previous shot. Start with his attention already turned toward her. She slides one small white eraser across the short clear desk edge toward him with her left hand. He receives it with his right hand and gives a quiet grateful smile; she smiles briefly and returns her eyes to her exercise book. Keep both hands, the eraser and the two faces visible. No long dialogue, no new student entering, no camera orbit.

衔接：固定S06参考/实际末帧身份；交接只一次，桌子不可连成别样布局。

检查：女孩是未来伴侣同一身份；推→接→回应依次发生；橡皮不变物体、不穿手。

## S08 · 教室记录收回，走向树下
65.5—68.5 秒；controlled_spatial_composite。
S07小卡收回原课桌锚点，S06后排记录可见。相机退出教室沿连廊向树下/操场边走，AI询问“这个同学，后来还联系吗？”

检查：不跳出整个校园；上课的记忆只在照片内。

## S09 · 点开毕业前后
68.5—70 秒；controlled_spatial_composite。
树下毕业照片选中放大，欢声先进入；接S10活的合影准备，不先显示另一套人物。

检查：已建立的树/楼位置一致。

## S10 · 毕业：被朋友叫到一起
70—74 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Wide smartphone group-photo framing under the large campus tree beside the teaching building, late afternoon. The protagonist and the same ponytailed girl are now eighteen, still in white school shirts and dark bottoms. A small group of classmates arranges itself in two loose rows. The boy and girl begin with a small gap; a friend beside them gestures for them to stand closer. They each take half a step toward the gap and smile awkwardly. Keep ordinary graduation-day clothes, no mortarboards or university gowns. Camera remains at eye level, stable and wide enough to see their feet and the familiar building. End with the group finally ready for the photo.

衔接：S11从合照刚完成后松下来，不重新排一次队。

检查：同校同人；移动半步自然；不把初高中毕业变大学场景。

## S11 · 毕业：快门之后还在笑
74—78 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A medium-wide candid smartphone angle from a friend a few steps to the side of the same graduation group. Start just after the group photo has been taken. The same boy and girl remain next to each other under the same tree, with identical faces and uniforms. They release their formal smiles into a spontaneous laugh as a classmate fans their face with an exercise booklet. The boy glances at the girl, then both look toward their laughing friend. Camera makes a tiny human adjustment but stays on the same side of the group. End on their relaxed shared glance, leaving half a second of calm reaction.

衔接：S10站位保留到S11，合影快门声跨切镜一次。

检查：时间往前；伴侣身份清楚；额外人不凭空变位。

## S12 · 校园完整退远，横滑到婚礼
78—84 秒；controlled_spatial_composite。
毕业记录收回树下；教室、校门和操场的多个入口一起显现。相机升高让整个校园完整出现，整体向左滑，婚礼庭院从右侧进入。

检查：校园内三段均已播放；统一换地语言；照片随地点移动。

## W01 · 进入婚礼廊下的照片
84—86 秒；controlled_spatial_composite。
从婚礼庭院完整布局下降到准备廊下，侧面可见中央舞池和宾客席，点开准备照片接W02。

检查：必须落到人尺度；准备区/舞池/父母席方位可追踪。

## W02 · 婚礼前：等她扶正胸花
86—90 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Medium smartphone view in the sheltered preparation arcade along the back of the wedding courtyard at warm dusk. The adult protagonist, around twenty-eight, wears a dark suit and white shirt, with the approved adult face. The bride is the same girl grown older, in a simple white wedding dress and low black hair bun. He finishes straightening one shirt cuff and notices his slightly tilted boutonniere. She steps half a pace toward him and lifts her right hand toward the flower. Warm lamps and the courtyard opening stay visible behind them. Friend films from their front-left at chest height. End before she touches the flower.

衔接：W03接手刚抬起去扶胸花，衣服/胸花/发型不变。

检查：伴侣不是随机新脸；准备区真实属于庭院；胸花没有先被扶正。

## W03 · 婚礼前：扶正胸花，相视一笑
90—94 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A closer smartphone view from another friend within the same wedding arcade, still on the same side of the couple's axis. Continue the bride's raised right hand from the previous shot. She gently straightens the small boutonniere on the groom's left lapel, withdraws her hand, and looks into his eyes. The same groom smiles back softly. Keep their established adult faces, dark suit, white dress, low hair bun and warm dusk lighting. Frame from mid-torso upward so the flower, hand and two faces remain visible. Nearly locked camera. End after their small shared smile, with the flower remaining straight.

衔接：单次扶正，不多次摸花；下一段通过空间去舞池。

检查：胸花左右正确；同一伴侣；镜尾留反应。

## W04 · 廊下记录收回，走向舞池
94—97 秒；controlled_spatial_composite。
W03收回廊下小卡，W02相邻。沿庭院边缘向舞池小卡移动，宾客席中另有父母反应记录。

检查：婚礼也有内部漫游；不在每个反应后缩整院。

## W05 · 点开舞池回忆
97—98.5 秒；controlled_spatial_composite。
舞池小卡边缘亮一下，靠近对齐展开接W06，现场笑声连续。

检查：小照片而非巨型屏幕。

## W06 · 跳舞：开始慢慢转半圈
98.5—102.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Medium-wide smartphone view from the southwest edge of the courtyard dance floor at dusk. The same bride and groom begin a gentle slow dance. Groom holds her right hand in his left, his right hand resting at her upper back. They take two small coordinated steps and start a modest clockwise half-turn as seen from above. Keep full torsos and feet visible, familiar warm string lights, tree trunk and arcades fixed. Camera stays in place with a small pan following their turn. End during the turn before they face one another in the new direction. Do not spin quickly or lift the bride.

衔接：记录终点朝向给W07，用实际末帧检查握手与转向。

检查：同一双人不换脸；握手结构稳定；转向单一。

## W07 · 跳舞：转完后看向彼此
102.5—106.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. A slightly closer smartphone view from a friend along the west side of the same courtyard dance floor. The same bride and groom continue the already-started clockwise turn for its remaining small arc, then settle facing each other and smile. Retain exactly the established handhold, wardrobe, hairstyles and relative positions of the arcade, tree and guest seating. Choose the start pose from the actual prior clip ending; do not begin another full spin. Keep the camera steady with a mild pan only. End with them stopped briefly in a relaxed dance stance, looking at one another.

衔接：不能拿旧反打首帧强行重置转角；若越轴以中性两人近景承接。

检查：动作连续而不是再跳一遍；左右握手不反转；新视角仍同院。

## W08 · 主角没看见的父母反应
106.5—110.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Medium smartphone reaction view from a guest beside the west arcade, looking toward the groom's parents seated together at the edge of the same wedding courtyard. His father, now older with greying hair and a restrained dark suit, applauds gently. His mother, naturally aged from the childhood scenes and wearing a muted formal outfit, smiles while holding up a smartphone to record the couple offscreen. Keep their faces distinct from grandmother. Their eyelines point toward the established dance floor. Warm dusk light and the same table decorations link the space. One steady four-second shot with natural applause and quiet laughter; no cut back inside the shot.

衔接：婚礼音乐/笑声跨W06-08连续；这是真实反应视角，不声称手机自拍。

检查：母亲拍摄是手机；父母合理变老；父母未被复制到舞池。

## W09 · 婚礼多份记录一起留在空间
110.5—113.5 秒；controlled_spatial_composite。
W08收回父母席附近小卡，舞池W06/W07和廊下W02/W03均在各自位置。小幅侧移展示多人记录连起同一场婚礼，准备衔接老人手机屏幕。

检查：至少两件完整婚礼故事；多来源位置正确；此处不再横滑去旧家。

## E01 · 老人手中的手机
113.5—117.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Close over-shoulder view of the same protagonist at about seventy-two in a new city apartment reading nook. He wears a pale knit cardigan and holds a modern smartphone calmly in both hands. Grey hair, natural aged facial structure from the reference. Keep the phone screen a plain dim neutral surface for later compositing. He makes one small thumb movement near the lower screen edge, then rests his thumb. Warm window light, an upholstered reading chair and bookshelf establish a new home, not the childhood dining room. Camera slowly draws back about thirty centimeters, keeping the phone quadrilateral visible and stable. No generated app UI or readable text.

衔接：后期把W09空间图贴入真实屏幕，手机与手出现形成揭示。

检查：真实手机比例/手部正常；屏幕可跟踪替换；新住处区别旧家。

## E02 · 他们还在一起
117.5—121.5 秒；h3_generated_action。
Naturalistic personal-memory footage with believable human movement and gently handheld smartphone perspective. Keep the approved faces, clothes, lighting and room geometry. One continuous shot, no internal cuts, no age change, no photo cards, no text, no camera flying outside, no slow motion, no duplicated people, no DV camcorder. Medium-wide continuation in the same new apartment reading nook, from the same side of the elderly man and phone. The seventy-two-year-old man lowers his smartphone slightly and looks toward his wife in the neighboring chair by the window. She is the same lifelong partner naturally aged, softly smiling back, with consistent facial features from school and wedding. Bookshelf and city-window light remain in the same positions. He smiles in recognition; they share a quiet glance. A slow modest camera retreat reveals both chairs, no orbit, no new room, no transition back to the childhood house. End on a calm two-shot with space for later typography.

衔接：E01手机、开衫、窗方向一致，动作继续而不是重新拿起。

检查：同一伴侣身份有据可循；不强加去世等催泪情节；结尾有呼吸。

## E03 · 片尾
121.5—124.5 秒；controlled_spatial_composite。
安静两人画面自然淡到片尾排版：那些年，你没看见的，也有人替你记着。UNSEEN；小字概念演示。保留轻环境声尾音，不突断。

检查：文字准确后期排版；无未验证产品承诺。

