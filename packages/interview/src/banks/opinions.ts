import type { QuestionBank } from "../bank.ts";

/** How the person works and what they believe: stances and voice. */
export const OPINIONS_V1: QuestionBank = {
  id: "opinions-v1",
  sections: [
    {
      id: "work",
      title: "How you work",
      questions: [
        {
          id: "work.style",
          text: "How do you like to work: alone or in a team, fast or careful, mornings or nights?",
          feeds: ["stance", "voice"],
        },
        { id: "work.collaborator", text: "What makes a collaborator great to work with, for you?", feeds: ["stance"] },
      ],
    },
    {
      id: "opinions",
      title: "Opinions",
      repeat: { label: "Opinion", copies: 3 },
      questions: [
        { id: "opinions.claim", text: "A strong opinion you hold in your field.", feeds: ["stance"] },
        { id: "opinions.why", text: "Why do you think so?", feeds: ["stance", "voice"] },
        { id: "opinions.strength", text: "How strongly (1–5), and what would change your mind?", feeds: ["stance"] },
      ],
    },
    {
      id: "contrarian",
      title: "Against the grain",
      questions: [
        { id: "contrarian.disagree", text: "What do you disagree with most people in your field about?", feeds: ["stance"] },
        { id: "contrarian.changed", text: "What's an opinion you've changed your mind on?", feeds: ["stance", "voice"] },
      ],
    },
  ],
};
