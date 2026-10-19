import type { DataRegion } from "../../services/identity/anonymous-identity-api.ts";

function dataRegionFromProjectId(projectId: string): DataRegion {
    const code = projectId.split("_", 3)[1];
    switch (code) {
        case "en":
            return "enam";
        case "sa":
            return "sam";
        case "we":
            return "weur";
        case "ee":
            return "eeur";
        case "an":
            return "apac-ne";
        case "as":
            return "apac-se";
        case "oc":
            return "oc";
        case "af":
            return "afr";
        case "me":
            return "me";
        case "wn":
            return "wnam";
        default:
            return "apac";
    }
}

export function projectLocationLabel(projectId: string): string {
    switch (dataRegionFromProjectId(projectId)) {
        case "wnam":
            return "Western North America";
        case "enam":
            return "Eastern North America";
        case "sam":
            return "South America";
        case "weur":
            return "Western Europe";
        case "eeur":
            return "Eastern Europe";
        case "apac":
            return "Asia Pacific";
        case "apac-ne":
            return "Northeast Asia";
        case "apac-se":
            return "Southeast Asia";
        case "oc":
            return "Oceania";
        case "afr":
            return "Africa";
        case "me":
            return "Middle East";
    }
}
