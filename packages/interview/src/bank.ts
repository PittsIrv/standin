/** What an answer is expected to produce once compacted. Shown to the person as a hint. */
export type Feeds = "fact" | "current" | "competence" | "negative" | "stance" | "voice" | "guide";

export interface Question {
  /** Stable id (`section.name`). Answers are matched to questions by it. */
  id: string;
  en: string;
  zh: string;
  feeds: Feeds[];
  /** Optional extra guidance, shown under the question. */
  hint?: { en: string; zh: string };
}

export interface Section {
  id: string;
  title: { en: string; zh: string };
  questions: Question[];
}

export interface QuestionBank {
  id: string;
  sections: Section[];
}

/**
 * The first interview: about 30 questions, 30–45 minutes. It deliberately has no
 * "what is off limits" questions. Answers here become memories, and naming a
 * sensitive topic would create one. Boundaries are set in the airlock instead.
 */
export const CORE_V1: QuestionBank = {
  id: "core-v1",
  sections: [
    {
      id: "basics",
      title: { en: "Basics", zh: "基本情况" },
      questions: [
        {
          id: "basics.intro",
          en: "How would you introduce yourself to someone you just met at a conference?",
          zh: "在会议上遇到一个陌生人，你会怎么介绍自己？",
          feeds: ["fact", "voice"],
        },
        {
          id: "basics.path",
          en: "How did you get to where you are now? Schools, turning points, places you've lived.",
          zh: "你是怎么走到现在的？学校、转折点、住过的地方。",
          feeds: ["fact"],
          hint: { en: "City-level places are enough.", zh: "地点写到城市就够了。" },
        },
        {
          id: "basics.languages",
          en: "Which languages do you use, and when do you switch between them?",
          zh: "你用哪些语言？什么时候会切换？",
          feeds: ["fact", "voice"],
        },
      ],
    },
    {
      id: "now",
      title: { en: "Right now", zh: "最近" },
      questions: [
        {
          id: "now.work",
          en: "What are you working on right now, and why that?",
          zh: "你现在在做什么？为什么做这个？",
          feeds: ["current", "fact"],
        },
        {
          id: "now.learning",
          en: "What are you learning or trying to get better at these days?",
          zh: "最近在学什么，或者想在哪方面变得更好？",
          feeds: ["current", "competence"],
        },
        {
          id: "now.consuming",
          en: "What have you been reading, watching, or playing lately?",
          zh: "最近在读、在看、在玩什么？",
          feeds: ["current"],
        },
        {
          id: "now.next",
          en: "What do you want to be doing a year from now?",
          zh: "一年以后，你希望自己在做什么？",
          feeds: ["stance"],
        },
      ],
    },
    {
      id: "projects",
      title: { en: "Projects", zh: "项目" },
      questions: [
        {
          id: "projects.proud",
          en: "Which project are you proudest of? What was hard about it, and what did you do?",
          zh: "你最骄傲的项目是哪个？难在哪里，你具体做了什么？",
          feeds: ["fact", "competence"],
        },
        {
          id: "projects.failed",
          en: "Tell me about something you built that didn't work out. What did you learn?",
          zh: "讲一个没做成的项目。你从中学到了什么？",
          feeds: ["fact", "stance"],
        },
        {
          id: "projects.role",
          en: "On team projects, which part do you usually end up owning?",
          zh: "团队项目里，你通常会负责哪一部分？",
          feeds: ["fact", "competence"],
        },
        {
          id: "projects.site",
          en: "What's on your website, and what should a first-time visitor look at first?",
          zh: "你的个人网站上有什么？第一次来的人应该先看什么？",
          feeds: ["guide"],
        },
      ],
    },
    {
      id: "competence",
      title: { en: "What you know, and what you don't", zh: "你懂什么，不懂什么" },
      questions: [
        {
          id: "competence.strong",
          en: "Which areas are you strongest in? For each, how deep, and what have you done that shows it?",
          zh: "你最擅长哪些领域？每个有多深，有什么经历能说明？",
          feeds: ["competence"],
          hint: {
            en: "Depth scale: aware of it · working knowledge · strong · expert.",
            zh: "深度：了解 · 能上手 · 很强 · 专家。",
          },
        },
        {
          id: "competence.working",
          en: "Which areas can you work in, but wouldn't call yourself an expert in?",
          zh: "哪些领域你能上手，但不算专家？",
          feeds: ["competence"],
        },
        {
          id: "competence.gaps",
          en: "Which topics near your field do people assume you know, but you actually don't?",
          zh: "哪些和你领域相关的话题，别人以为你懂，其实你不太懂？",
          feeds: ["negative"],
          hint: {
            en: "This is what lets the standin say \"I don't know\" instead of guessing. Be specific.",
            zh: "这是standin能说\"我不知道\"而不是瞎猜的关键。越具体越好。",
          },
        },
        {
          id: "competence.never",
          en: "What have you never done or used that someone might reasonably ask you about?",
          zh: "有哪些事你从没做过或用过，但别人很可能会问你？",
          feeds: ["negative"],
        },
        {
          id: "competence.outside",
          en: "Outside your field, is there anything you know unusually well?",
          zh: "在专业之外，有没有什么你特别懂的？",
          feeds: ["competence"],
        },
      ],
    },
    {
      id: "stances",
      title: { en: "Views", zh: "看法" },
      questions: [
        {
          id: "stances.ai",
          en: "What do you believe about AI that many people around you don't?",
          zh: "关于AI，你有哪些和身边多数人不一样的看法？",
          feeds: ["stance"],
        },
        {
          id: "stances.craft",
          en: "What makes code, writing, or design good to you?",
          zh: "在你看来，好的代码、文字或设计是什么样的？",
          feeds: ["stance"],
        },
        {
          id: "stances.work",
          en: "How do you like to work, and what do you avoid?",
          zh: "你喜欢怎样工作？会刻意避开什么？",
          feeds: ["stance", "fact"],
        },
        {
          id: "stances.changed",
          en: "What have you changed your mind about in the last few years?",
          zh: "这几年你改变过什么看法？",
          feeds: ["stance"],
          hint: { en: "Say what you used to think, too.", zh: "也写写你以前是怎么想的。" },
        },
        {
          id: "stances.disagree",
          en: "Which popular opinion in your field do you disagree with?",
          zh: "你领域里有哪个流行观点是你不认同的？",
          feeds: ["stance"],
        },
      ],
    },
    {
      id: "taste",
      title: { en: "Taste", zh: "喜好" },
      questions: [
        {
          id: "taste.shaped",
          en: "Which books, games, poems, or other work shaped you, and why?",
          zh: "哪些书、游戏、诗或作品影响过你？为什么？",
          feeds: ["fact", "stance"],
        },
        {
          id: "taste.free",
          en: "What do you do when nobody needs anything from you?",
          zh: "没人找你的时候，你会做什么？",
          feeds: ["fact"],
        },
        {
          id: "taste.dislike",
          en: "What do other people enjoy that you just don't?",
          zh: "有什么别人喜欢、你却不喜欢的东西？",
          feeds: ["stance", "negative"],
        },
      ],
    },
    {
      id: "voice",
      title: { en: "How you talk", zh: "你说话的方式" },
      questions: [
        {
          id: "voice.explain",
          en: "Explain your proudest project to a friend who isn't technical, the way you'd text it.",
          zh: "用发消息的语气，给一个不懂技术的朋友讲讲你最骄傲的项目。",
          feeds: ["voice"],
          hint: { en: "Don't polish this. Typos are fine.", zh: "不用润色，有错字也没关系。" },
        },
        {
          id: "voice.idk",
          en: "How do you usually say \"I don't know\" or \"not sure\"? Give a few ways.",
          zh: "你平时怎么说\"我不知道\"或\"不确定\"？写几种说法。",
          feeds: ["voice"],
          hint: { en: "In both languages, if you use both.", zh: "如果你中英文都用，两种都写。" },
        },
        {
          id: "voice.decline",
          en: "Someone asks about something you'd rather not discuss. How do you steer away politely?",
          zh: "有人问到你不想聊的事，你会怎么礼貌地岔开？",
          feeds: ["voice"],
          hint: {
            en: "Write how you'd say it. Don't name the topic.",
            zh: "写你会怎么说就好，不用写是什么话题。",
          },
        },
        {
          id: "voice.excited",
          en: "Write a message about something you're excited about right now.",
          zh: "写一条消息，聊一件你最近很兴奋的事。",
          feeds: ["voice", "current"],
        },
        {
          id: "voice.feedback",
          en: "How do you give a friend critical feedback on their work? Write an example.",
          zh: "你会怎么给朋友的作品提批评意见？写一个例子。",
          feeds: ["voice"],
        },
        {
          id: "voice.never",
          en: "Which words, phrases, or tones would sound fake coming from you?",
          zh: "哪些词、说法或语气从你嘴里说出来会很假？",
          feeds: ["voice"],
        },
      ],
    },
    {
      id: "standin",
      title: { en: "Your standin", zh: "你的standin" },
      questions: [
        {
          id: "standin.purpose",
          en: "When someone finishes talking to your standin, what do you hope they leave with?",
          zh: "别人和你的standin聊完，你希望他们带走什么？",
          feeds: ["guide"],
        },
        {
          id: "standin.handoff",
          en: "When should the standin send someone to the real you, and how should they reach you?",
          zh: "什么时候standin应该让对方直接找你本人？怎么联系你？",
          feeds: ["guide"],
          hint: { en: "Only contact details you'd put on your website.", zh: "只写你愿意放在网站上的联系方式。" },
        },
      ],
    },
  ],
};

export const BANKS: Record<string, QuestionBank> = { [CORE_V1.id]: CORE_V1 };

export function allQuestions(bank: QuestionBank): Question[] {
  return bank.sections.flatMap((s) => s.questions);
}
