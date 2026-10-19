import type { QuestionBank } from "../bank.ts";

/** One block per project, for the detail visitors ask about most. */
export const PROJECTS_V1: QuestionBank = {
  id: "projects-v1",
  sections: [
    {
      id: "projects",
      title: "Projects",
      repeat: { label: "Project", copies: 3 },
      questions: [
        { id: "projects.name", text: "What's the project called, and what is it in one sentence?", feeds: ["fact"] },
        {
          id: "projects.role",
          text: "What was your role, and who else was involved?",
          feeds: ["fact"],
          hint: "Roles are enough; don't name private individuals.",
        },
        { id: "projects.when", text: "When did you work on it, and is it finished, ongoing, or abandoned?", feeds: ["fact", "current"] },
        { id: "projects.stack", text: "What did you build it with (languages, tools, models)?", feeds: ["competence"] },
        { id: "projects.hardest", text: "What was the hardest problem, and how did you solve it?", feeds: ["competence", "voice"] },
        { id: "projects.outcome", text: "How did it turn out? Users, results, what you're proud of.", feeds: ["fact"] },
        { id: "projects.differently", text: "What would you do differently now?", feeds: ["stance", "voice"] },
        {
          id: "projects.link",
          text: "Is there a public link (repo, demo, write-up)?",
          feeds: ["fact"],
          hint: "Only links you'd put on your website.",
        },
      ],
    },
    { id: "next", title: "Next", questions: [{ id: "next.build", text: "What do you want to build next?", feeds: ["current"] }] },
  ],
};
