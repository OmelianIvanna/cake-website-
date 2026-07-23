import { writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const formId = process.env.TALLY_FORM_ID || "RGae6d";
const outputPath = process.env.REVIEWS_OUTPUT || "data/approved-reviews.json";
const includeAll = process.argv.includes("--include-all");
const debug = process.argv.includes("--debug");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const submissionFilter = argValue("filter", "completed");
const pageLimit = Math.max(1, Math.min(500, Number(argValue("limit", "100")) || 100));

async function readSecret(prompt) {
  if (process.env.TALLY_API_KEY) return process.env.TALLY_API_KEY;

  const rl = createInterface({ input, output });
  const secret = await rl.question(prompt);
  rl.close();
  return secret.trim();
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isApproved(value) {
  return ["yes", "true", "approved", "1", "y", "так", "да", "ano"].includes(normalize(value));
}

function fieldTitle(field) {
  return normalize(field.label || field.title || field.name || field.key || field.question || "");
}

function fieldValue(field) {
  const value = field.formattedAnswer ?? field.answer ?? field.value;
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return "";
  return String(value).trim();
}

function pickField(fields, names) {
  const wanted = names.map(normalize);
  return fields.find((field) => {
    const title = fieldTitle(field);
    return wanted.some((name) => title === name || title.includes(name));
  });
}

function mapSubmission(submission, questionTitles) {
  const fields = (submission.responses || submission.fields || submission.answers || []).map((field) => ({
    ...field,
    question: questionTitles.get(field.questionId) || field.question
  }));
  const name = fieldValue(pickField(fields, ["your name", "name", "ім'я", "ім’я", "meno"]));
  const rating = Number(fieldValue(pickField(fields, ["your rating", "rating", "оцінка", "hodnotenie"]))) || 5;
  const review = fieldValue(pickField(fields, ["your review", "review", "відгук", "recenzia"]));
  const approvedField = pickField(fields, ["approved", "approve", "схвалено", "approved for site"]);

  return {
    name: name || "Guest",
    rating: Math.max(1, Math.min(5, rating)),
    review,
    approved: approvedField ? isApproved(fieldValue(approvedField)) : includeAll
  };
}

async function fetchSubmissions(apiKey) {
  const submissions = [];
  const questionTitles = new Map();
  let page = 1;

  while (true) {
    const url = new URL(`https://api.tally.so/forms/${formId}/submissions`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("filter", submissionFilter);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      throw new Error(`Tally API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const pageItems = data.submissions || data.items || data.data || [];

    (data.questions || []).forEach((question) => {
      if (question.id && question.title) questionTitles.set(question.id, question.title);
      (question.fields || []).forEach((field) => {
        const title = field.title || question.title;
        [field.id, field.uuid, field.key].filter(Boolean).forEach((key) => {
          if (title) questionTitles.set(key, title);
        });
        if (field.uuid && title) {
          questionTitles.set(field.uuid, title);
        }
      });
    });

    submissions.push(...pageItems);

    const hasNext = data.hasMore || data.has_more || data.nextPage || data.next_page;
    if (!hasNext || pageItems.length === 0) break;
    page += 1;
  }

  return { submissions, questionTitles };
}

const apiKey = await readSecret("Tally API key: ");
const { submissions, questionTitles } = await fetchSubmissions(apiKey);
const mappedReviews = submissions
  .filter((submission) => submission.isCompleted !== false)
  .map((submission) => mapSubmission(submission, questionTitles));
const reviews = mappedReviews
  .filter((review) => review.review && review.approved)
  .slice(0, 9)
  .map(({ name, rating, review }) => ({ name, rating, review }));

if (debug) {
  console.log(`Form: ${formId}`);
  console.log(`Filter: ${submissionFilter}`);
  console.log(`Limit per page: ${pageLimit}`);
  console.log(`Completed submissions: ${mappedReviews.length}`);
  console.log(`Question titles: ${[...new Set(questionTitles.values())].join(" | ") || "none detected"}`);
  console.log(`Reviews with text: ${mappedReviews.filter((review) => review.review).length}`);
  console.log(`Reviews selected for site: ${reviews.length}`);
  if (!reviews.length && mappedReviews.length) {
    console.log("First mapped submission preview:");
    console.log(JSON.stringify(mappedReviews[0], null, 2));
  }
}

await writeFile(outputPath, `${JSON.stringify(reviews, null, 2)}\n`);
console.log(`Saved ${reviews.length} reviews to ${outputPath}`);
