/** How a finding is named to the person: a provider and what it is ("GitHub token"), never the matched text. */
const FIXED: Record<string, string> = {
  "generic-api-key": "API key or token",
  password: "password",
  "private-key": "private key",
  "card-number": "card number",
  iban: "bank account (IBAN)",
  "cn-resident-id": "Chinese resident ID",
  "us-ssn": "US Social Security number",
  email: "email address",
  phone: "phone number",
  "street-address": "street address",
  jwt: "login token (JWT)",
  "jwt-base64": "login token (JWT)",
  "curl-auth-header": "login header in a curl command",
  "curl-auth-user": "login in a curl command",
  "age-secret-key": "age encryption key",
  "aws-access-token": "AWS key",
};

const PROVIDERS: Record<string, string> = {
  "1password": "1Password", aws: "AWS", gcp: "Google Cloud", github: "GitHub", gitlab: "GitLab", openai: "OpenAI",
  huggingface: "Hugging Face", digitalocean: "DigitalOcean", hubspot: "HubSpot", launchdarkly: "LaunchDarkly",
  linkedin: "LinkedIn", mailchimp: "Mailchimp", messagebird: "MessageBird", new: "New Relic", npm: "npm",
  nytimes: "New York Times", pypi: "PyPI", rubygems: "RubyGems", sendgrid: "SendGrid", sourcegraph: "Sourcegraph",
  planetscale: "PlanetScale", privateai: "Private AI", rapidapi: "RapidAPI", droneci: "Drone CI", travisci: "Travis CI",
  flyio: "Fly.io", frameio: "Frame.io", intra42: "42 Intra", openshift: "OpenShift", settlemint: "SettleMint",
  sumologic: "Sumo Logic", clickhouse: "ClickHouse", gocardless: "GoCardless", freshbooks: "FreshBooks",
  easypost: "EasyPost", maxmind: "MaxMind", jfrog: "JFrog", hashicorp: "HashiCorp", microsoft: "Microsoft Teams",
  cisco: "Cisco Meraki", defined: "Defined Networking", octopus: "Octopus Deploy", squarespace: "Squarespace",
};

export function labelOf(rule: string): string {
  const fixed = FIXED[rule];
  if (fixed) return fixed;
  const [head = rule] = rule.split("-");
  const provider = PROVIDERS[head] ?? head.charAt(0).toUpperCase() + head.slice(1);
  const what = /pat|token|bearer/.test(rule) ? "token" : /secret/.test(rule) ? "secret" : /password/.test(rule) ? "password" : /webhook|url/.test(rule) ? "webhook link" : "key";
  return `${provider} ${what}`;
}
