// Track 8B/8A demo-book content. Pure data only — no I/O, no photo bytes.
//
// This is a hand-authored demonstration book for the "夏日聚会" (summer gathering) AI template
// space (six stock photos under ~/code/unseen-assets/ai-template-space/). It exists to show what a
// finished Book Lab memory book looks like end to end (photos -> AI-style question -> short human
// answer -> printed page), using the real, already-tested renderer in packages/book-renderer.
//
// It is NOT real user data and did not go through the live Book Lab interview/authorization flow
// (BOOK.FREEZE etc.) — the manifest below is assembled directly, the way
// packages/book-renderer/fixtures/frozen-book-fixture.mjs assembles its own fixture. Every question
// and answer is fictional, written by this task's operator, grounded only in what's visibly in each
// stock photo. Authorship is credited to the neutral "朋友们" (friends) rather than any invented
// individual name, per instruction.
//
// Photo files referenced (relative to the demo asset directory passed to build-demo-book.mjs):
export const PHOTO_FILES = [
  { photoId: "photo-cheers", file: "photo1_cheers.jpg", label: "干杯" },
  { photoId: "photo-cake", file: "photo2_cake.jpg", label: "蛋糕" },
  { photoId: "photo-group-back", file: "photo3_group_back.jpg", label: "长桌背影" },
  { photoId: "photo-table-detail", file: "photo4_table_detail.jpg", label: "餐桌细节" },
  { photoId: "photo-laughing", file: "photo5_laughing.jpg", label: "大笑" },
  { photoId: "photo-dancing", file: "photo6_dancing.jpg", label: "跳舞" }
];

export const BOOK_TITLE = "夏夜长桌";

// frozenAt anchors both the manifest and the canonical PDF CreationDate/ModDate.
export const FROZEN_AT = "2026-08-16T20:30:00+08:00";

const AUTHOR_CREDIT = "朋友们";

// Two grounded Q&A per photo, in the narrative order the book presents them (arrival toast -> table
// being set -> everyone seated -> dinner-table laughter -> cake -> dancing at the end of the night).
// `time` is the in-story capture clock time used for the on-page provenance ribbon and for
// sourceProvenance.capturedAt; it does not need to be literally true, only internally consistent.
export const MEMORY_ENTRIES = [
  {
    photoId: "photo-cheers", time: "18:32",
    question: "举杯的这一下，两只杯子里分别是什么？",
    answer: "一杯是气泡水加了柠檬片，另一杯是很淡的莓子特调，后来谁也没说清自己喝的是哪杯。"
  },
  {
    photoId: "photo-cheers", time: "18:33",
    question: "碰杯的这一声，是谁先碰响的？",
    answer: "两只杯子几乎同时碰上，叮的一声，旁边立刻有人喊“别晃，要拍糊了”。"
  },
  {
    photoId: "photo-table-detail", time: "18:47",
    question: "桌上这几盆带小白花的盆栽，是特意买的吗？",
    answer: "不是，是院子角落原本就有的盆栽，摆桌子的时候顺手搬过来撑场面。"
  },
  {
    photoId: "photo-table-detail", time: "18:49",
    question: "这套花纹碗碟，是为这顿饭新买的吗？",
    answer: "不是，是家里现成的旧碗，洗干净就端上来了，倒挺配这顿饭的颜色。"
  },
  {
    photoId: "photo-group-back", time: "19:05",
    question: "长桌最那头的小朋友，那会儿在忙什么？",
    answer: "一直低头摆弄一个小玩具，没怎么抬头，倒是全场第一个吃完饭的人。"
  },
  {
    photoId: "photo-group-back", time: "19:07",
    question: "烛光摇晃的这一刻，大家在聊什么？",
    answer: "像是在讲一件很久以前的糗事，具体讲的是什么没录下来，但笑声比说话声还大。"
  },
  {
    photoId: "photo-laughing", time: "19:26",
    question: "这一桌笑成这样，是谁的话把大家逗成这样的？",
    answer: "中间那位讲到一半自己先绷不住笑场了，剩下的人是被他笑场的样子逗笑的，不是被内容逗笑的。"
  },
  {
    photoId: "photo-laughing", time: "19:28",
    question: "这张圆桌旁一共坐了几个人？",
    answer: "五个，后来又有人端着盘子挤过来加了张椅子，勉强也坐下了。"
  },
  {
    photoId: "photo-cake", time: "19:52",
    question: "蛋糕上一共插了几根蜡烛？",
    answer: "数了两次，一次十根一次十一根，最后大家决定不许再数了，够亮就行。"
  },
  {
    photoId: "photo-cake", time: "19:54",
    question: "吹蜡烛前，大家唱了什么歌？",
    answer: "唱了两遍生日歌，第二遍全跑调，跑调之后反而唱得更大声了。"
  },
  {
    photoId: "photo-dancing", time: "20:31",
    question: "草地上跳起来的这两位，当时放的是什么歌？",
    answer: "没人记得歌名，只记得副歌一响，两个人就同时从椅子上弹了起来。"
  },
  {
    photoId: "photo-dancing", time: "20:33",
    question: "他们俩当时都光着脚，鞋去哪儿了？",
    answer: "早就脱在长桌底下了，草地凉凉的，踩上去人反而更精神。"
  }
];

export const AUTHOR = AUTHOR_CREDIT;

// Cover uses the first photo (the toast) as the establishing shot.
export const COVER_PHOTO_ID = "photo-cheers";
