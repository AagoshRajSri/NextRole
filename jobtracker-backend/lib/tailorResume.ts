// ────────────────────────────────────────────────────────
// SHARED AI RESUME TAILORING
// Extracted so the sync REST endpoint (/api/resumes/tailor)
// and the BullMQ batch worker (worker.ts) share identical logic.
// ────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

const ANTHROPIC_MODEL = 'claude-3-5-sonnet-20240620';
const MAX_TOKENS = 3000;

export interface TailorInput {
  userId: string;
  jobTitle: string;
  companyName: string;
  jobLocation?: string;
  jobDescription: string;
  /** If provided the result is saved to this JobSnapshot.id */
  jobSnapshotId?: string;
}

export interface TailorResult {
  resumeText: string;
  /** DB row id if the result was persisted */
  savedId?: string;
}

/**
 * Build the Claude prompt from user profile + job details.
 * Pure function — no I/O.
 */
export function buildTailorPrompt(params: {
  name?: string | null;
  experience: string;
  skills: string;
  education: string;
  projects: string;
  jobTitle: string;
  companyName: string;
  jobLocation: string;
  jobDescription: string;
}): string {
  return `You are an expert resume writer and career coach.
Your task is to tailor the user's resume sections (Experience, Skills, Education, Projects) to align with the following job description.

Job Title: ${params.jobTitle}
Company: ${params.companyName}
Location: ${params.jobLocation}
Job Description:
${params.jobDescription}

User's Current Resume Details:
Experience:
${params.experience || 'None'}

Skills:
${params.skills || 'None'}

Education:
${params.education || 'None'}

Projects:
${params.projects || 'None'}

Please tailor these sections to highlight relevant skills and achievements that match the requirements of the job.
Keep the output professional, formatted in clean markdown, containing sections for Tailored Experience, Tailored Skills, Tailored Projects, and Education.
Do not invent facts, only rephrase and emphasise existing experiences.`;
}

/**
 * Call Anthropic Claude (or return a mock in dev/test).
 * Throws on non-2xx from the Anthropic API.
 */
export async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey === 'sk-ant-123456') {
    // Dev / test mock — fast and free
    return `# Tailored Resume (MOCK)\n\n${prompt.slice(0, 200)}…\n\n*(Mock output — set ANTHROPIC_API_KEY to enable real Claude calls.)*`;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  const data = await response.json() as any;
  const text: string = data.content?.[0]?.text || '';
  if (!text) throw new Error('Anthropic returned an empty response');
  return text;
}

/**
 * Main entry point used by both the REST endpoint and the BullMQ worker.
 *
 * - Looks up the user profile from Postgres.
 * - Builds the prompt, calls Claude (or mock).
 * - Optionally persists the result to `TailoredResume` when `jobSnapshotId` is
 *   provided.
 *
 * Returns the `TailorResult`; throws on unrecoverable errors so callers can
 * decide whether to surface the error to the user or just log-and-continue.
 */
export async function tailorResume(
  prisma: PrismaClient,
  input: TailorInput,
): Promise<TailorResult> {
  const { userId, jobTitle, companyName, jobLocation = 'Not Specified', jobDescription, jobSnapshotId } = input;

  const userProfile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!userProfile) {
    throw new Error(`User profile not found for userId=${userId}`);
  }

  const hasResumeData =
    userProfile.experience || userProfile.skills || userProfile.education || userProfile.projects;
  if (!hasResumeData) {
    throw new Error('No resume data found in profile. Please fill in Experience, Skills, Education, or Projects first.');
  }

  const prompt = buildTailorPrompt({
    name: userProfile.name,
    experience: userProfile.experience,
    skills: userProfile.skills,
    education: userProfile.education,
    projects: userProfile.projects,
    jobTitle,
    companyName,
    jobLocation,
    jobDescription,
  });

  const resumeText = await callClaude(prompt);

  let savedId: string | undefined;
  if (jobSnapshotId && resumeText) {
    const saved = await prisma.tailoredResume.create({
      data: { jobSnapshotId, resumeText, pdfUrl: null },
    });
    savedId = saved.id;
  }

  return { resumeText, savedId };
}
