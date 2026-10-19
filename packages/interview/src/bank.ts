import { EDUCATION_V1 } from "./banks/education.ts";
import { LIFE_V1 } from "./banks/life.ts";
import { OPINIONS_V1 } from "./banks/opinions.ts";
import { PROJECTS_V1 } from "./banks/projects.ts";
import { SKILLS_V1 } from "./banks/skills.ts";

/** What an answer is expected to produce once compacted. Shown to the person as a hint. */
export type Feeds = "fact" | "current" | "competence" | "negative" | "stance" | "voice" | "guide";

export interface Question {
  /** Stable id (`section.name`). Answers are matched to questions by it. */
  id: string;
  text: string;
  feeds: Feeds[];
  /** Optional extra guidance, shown under the question. */
  hint?: string;
}

export interface Section {
  id: string;
  title: string;
  questions: Question[];
  /** A section answered once per item (each project, skill…): rendered as `copies` marked blocks. */
  repeat?: { label: string; copies: number };
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
      title: "Basics",
      questions: [
        {
          id: "basics.intro",
          text: "How would you introduce yourself to someone you just met at a conference?",
          feeds: ["fact", "voice"],
        },
        {
          id: "basics.path",
          text: "How did you get to where you are now? Schools, turning points, places you've lived.",
          feeds: ["fact"],
          hint: "City-level places are enough.",
        },
        {
          id: "basics.languages",
          text: "Which languages do you use, and when do you switch between them?",
          feeds: ["fact", "voice"],
        },
      ],
    },
    {
      id: "now",
      title: "Right now",
      questions: [
        {
          id: "now.work",
          text: "What are you working on right now, and why that?",
          feeds: ["current", "fact"],
        },
        {
          id: "now.learning",
          text: "What are you learning or trying to get better at these days?",
          feeds: ["current", "competence"],
        },
        {
          id: "now.consuming",
          text: "What have you been reading, watching, or playing lately?",
          feeds: ["current"],
        },
        {
          id: "now.next",
          text: "What do you want to be doing a year from now?",
          feeds: ["stance"],
        },
      ],
    },
    {
      id: "projects",
      title: "Projects",
      questions: [
        {
          id: "projects.proud",
          text: "Which project are you proudest of? What was hard about it, and what did you do?",
          feeds: ["fact", "competence"],
        },
        {
          id: "projects.failed",
          text: "Tell me about something you built that didn't work out. What did you learn?",
          feeds: ["fact", "stance"],
        },
        {
          id: "projects.role",
          text: "On team projects, which part do you usually end up owning?",
          feeds: ["fact", "competence"],
        },
        {
          id: "projects.site",
          text: "What's on your website, and what should a first-time visitor look at first?",
          feeds: ["guide"],
        },
      ],
    },
    {
      id: "competence",
      title: "What you know, and what you don't",
      questions: [
        {
          id: "competence.strong",
          text: "Which areas are you strongest in? For each, how deep, and what have you done that shows it?",
          feeds: ["competence"],
          hint: "Depth scale: aware of it · working knowledge · strong · expert.",
        },
        {
          id: "competence.working",
          text: "Which areas can you work in, but wouldn't call yourself an expert in?",
          feeds: ["competence"],
        },
        {
          id: "competence.gaps",
          text: "Which topics near your field do people assume you know, but you actually don't?",
          feeds: ["negative"],
          hint: "This is what lets the standin say \"I don't know\" instead of guessing. Be specific.",
        },
        {
          id: "competence.never",
          text: "What have you never done or used that someone might reasonably ask you about?",
          feeds: ["negative"],
        },
        {
          id: "competence.outside",
          text: "Outside your field, is there anything you know unusually well?",
          feeds: ["competence"],
        },
      ],
    },
    {
      id: "stances",
      title: "Views",
      questions: [
        {
          id: "stances.ai",
          text: "What do you believe about AI that many people around you don't?",
          feeds: ["stance"],
        },
        {
          id: "stances.craft",
          text: "What makes code, writing, or design good to you?",
          feeds: ["stance"],
        },
        {
          id: "stances.work",
          text: "How do you like to work, and what do you avoid?",
          feeds: ["stance", "fact"],
        },
        {
          id: "stances.changed",
          text: "What have you changed your mind about in the last few years?",
          feeds: ["stance"],
          hint: "Say what you used to think, too.",
        },
        {
          id: "stances.disagree",
          text: "Which popular opinion in your field do you disagree with?",
          feeds: ["stance"],
        },
      ],
    },
    {
      id: "taste",
      title: "Taste",
      questions: [
        {
          id: "taste.shaped",
          text: "Which books, games, poems, or other work shaped you, and why?",
          feeds: ["fact", "stance"],
        },
        {
          id: "taste.free",
          text: "What do you do when nobody needs anything from you?",
          feeds: ["fact"],
        },
        {
          id: "taste.dislike",
          text: "What do other people enjoy that you just don't?",
          feeds: ["stance", "negative"],
        },
      ],
    },
    {
      id: "voice",
      title: "How you talk",
      questions: [
        {
          id: "voice.explain",
          text: "Explain your proudest project to a friend who isn't technical, the way you'd text it.",
          feeds: ["voice"],
          hint: "Don't polish this. Typos are fine.",
        },
        {
          id: "voice.idk",
          text: "How do you usually say \"I don't know\" or \"not sure\"? Give a few ways.",
          feeds: ["voice"],
        },
        {
          id: "voice.decline",
          text: "Someone asks about something you'd rather not discuss. How do you steer away politely?",
          feeds: ["voice"],
          hint: "Write how you'd say it. Don't name the topic.",
        },
        {
          id: "voice.excited",
          text: "Write a message about something you're excited about right now.",
          feeds: ["voice", "current"],
        },
        {
          id: "voice.feedback",
          text: "How do you give a friend critical feedback on their work? Write an example.",
          feeds: ["voice"],
        },
        {
          id: "voice.never",
          text: "Which words, phrases, or tones would sound fake coming from you?",
          feeds: ["voice"],
        },
      ],
    },
    {
      id: "standin",
      title: "Your standin",
      questions: [
        {
          id: "standin.purpose",
          text: "When someone finishes talking to your standin, what do you hope they leave with?",
          feeds: ["guide"],
        },
        {
          id: "standin.handoff",
          text: "When should the standin send someone to the real you, and how should they reach you?",
          feeds: ["guide"],
          hint: "Only contact details you'd put on your website.",
        },
      ],
    },
  ],
};

export const BANKS: Record<string, QuestionBank> = Object.fromEntries(
  [CORE_V1, PROJECTS_V1, SKILLS_V1, EDUCATION_V1, OPINIONS_V1, LIFE_V1].map((b) => [b.id, b]),
);

export function allQuestions(bank: QuestionBank): Question[] {
  return bank.sections.flatMap((s) => s.questions);
}
