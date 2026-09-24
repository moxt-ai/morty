const variableNames = [
    "APP_ORIGIN",
    "AUTHENTICATION_BASE_URL",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_JWT_KEY",
    "MOBIUS_BASE_URL",
    "MOBIUS_APP_ID",
];
const secretNames = ["MOBIUS_APP_SECRET"];

const mode = process.argv[2] ?? "validate";
if (!["validate", "vars", "secrets"].includes(mode)) {
    console.error("Expected validate, vars, or secrets");
    process.exit(1);
}
const variables: Record<string, string> = {};
const secrets: Record<string, string> = {};
for (const name of [...variableNames, ...secretNames]) {
    const value = process.env[name];
    if (!value?.trim() || value.includes("\0")) {
        console.error(`Missing or invalid GitHub runtime setting: ${name}`);
        process.exit(1);
    }
    if (variableNames.includes(name)) {
        variables[name] = value;
    } else {
        secrets[name] = value;
    }
}

switch (mode) {
    case "vars":
        process.stdout.write(JSON.stringify(variables));
        break;
    case "secrets":
        process.stdout.write(JSON.stringify(secrets));
        break;
    default:
        console.log("Validated GitHub runtime variables and secrets for Chat");
}
