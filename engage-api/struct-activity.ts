// engage-api/struct-activity.ts
import pangu from 'pangu';
import { logger } from '../utils/logger';
import type { ActivityData } from '../models/activity';

// Define interfaces
interface ActivityField {
  fID: string;
  fData: string;
  fType?: string;
  lParms?: any[];
}

interface ActivityRow {
  rID: string;
  fields: ActivityField[];
}

interface RawActivityData {
  newRows: ActivityRow[];
  isError?: boolean;
}

interface Location {
  block: string | null;
  room: string | null;
  site: string | null;
}

interface Duration {
  endDate: string | null;
  isRecurringWeekly: boolean | null;
  startDate: string | null;
}

interface Grades {
  max: string | null;
  min: string | null;
}

interface Meeting {
  day: string | null;
  endTime: string | null;
  location: Location;
  startTime: string | null;
}

const clubSchema: ActivityData = {
  academicYear: null,
  category: null,
  description: null,
  duration: {
    endDate: null,
    isRecurringWeekly: null,
    startDate: null
  },
  grades: {
    max: null,
    min: null
  },
  id: null,
  isPreSignup: null,
  isStudentLed: null,
  materials: [],
  meeting: {
    day: null,
    endTime: null,
    location: {
      block: null,
      room: null,
      site: null
    },
    startTime: null
  },
  name: null,
  photo: null,
  poorWeatherPlan: null,
  requirements: [],
  schedule: null,
  semesterCost: null,
  staff: [],
  staffForReports: [],
  studentLeaders: []
};

async function applyFields(field: ActivityField, structuredActivityData: ActivityData): Promise<void> {
  switch (true) {
    case field.fID === "academicyear":
      structuredActivityData.academicYear = field.fData;
      break;
    case field.fID === "schedule":
      structuredActivityData.schedule = field.fData;
      break;
    case field.fID === "category":
      structuredActivityData.category = field.fData;
      break;
    case field.fID === "activityname":
      if (!structuredActivityData.name) structuredActivityData.name = "";
      structuredActivityData.name = await cleanText(field.fData);
      structuredActivityData.name = structuredActivityData.name.replaceAll("（", "(").replaceAll("）", ")");
      structuredActivityData.name = structuredActivityData.name.replaceAll("’", "'");
      structuredActivityData.name = structuredActivityData.name.replaceAll(".", "");
      structuredActivityData.name = structuredActivityData.name.replaceAll("IssuesT台上的社会问题", "Issues T 台上的社会问题");
      structuredActivityData.name =
        structuredActivityData.name.replaceAll("校管弦乐团(新老成员都适用", "校管弦乐团(新老成员都适用)").replaceAll("))",")");
      structuredActivityData.name = await pangu.spacing(structuredActivityData.name);
      break;
    case field.fID === "day":
      structuredActivityData.meeting.day = field.fData;
      break;
    case field.fID === "start":
      structuredActivityData.meeting.startTime = field.fData;
      break;
    case field.fID === "end":
      structuredActivityData.meeting.endTime = field.fData;
      break;
    case field.fID === "site":
      structuredActivityData.meeting.location.site = field.fData;
      break;
    case field.fID === "block":
      structuredActivityData.meeting.location.block = field.fData;
      break;
    case field.fID === "room":
      structuredActivityData.meeting.location.room = field.fData;
      break;
    case field.fID === "staff":
      let staff = field.fData.split(", ");
      structuredActivityData.staff = staff;
      break;
    case field.fID === "runsfrom":
      structuredActivityData.duration.startDate = field.fData;
      break;
    case field.fID === "runsto":
      structuredActivityData.duration.endDate = field.fData;
      break;
    case field.fData === "Recurring Weekly":
      structuredActivityData.duration.isRecurringWeekly = true;
      break;
    default:
      logger.debug(`No matching case for field: fID=${field.fID}, fType=${field.fType}`);
      break;
  }
}

async function cleanText(text: string | null | undefined): Promise<string> {
  if (!text) return "";
  return text.replaceAll("<br/>", "\n").replaceAll("\u000B", "\v").replaceAll("  "," ");
}

async function postProcess(structuredActivityData: ActivityData): Promise<void> {
  // Format description
  structuredActivityData.description = await cleanText(structuredActivityData.description);
  structuredActivityData.description = await pangu.spacing(structuredActivityData.description ?? "");
  structuredActivityData.description = structuredActivityData.description?.replaceAll("\n ", "\n") ?? "";
  // Format poorWeatherPlan
  if (structuredActivityData.poorWeatherPlan) {
    structuredActivityData.poorWeatherPlan = await cleanText(structuredActivityData.poorWeatherPlan);
    structuredActivityData.poorWeatherPlan = await pangu.spacing(structuredActivityData.poorWeatherPlan ?? "");
    structuredActivityData.poorWeatherPlan = structuredActivityData.poorWeatherPlan?.replaceAll("\n ", "\n") ?? "";
  } else {
    structuredActivityData.poorWeatherPlan = "";
  }
  // Format semesterCost
  if (structuredActivityData.semesterCost) {
    structuredActivityData.semesterCost = await cleanText(structuredActivityData.semesterCost);
    structuredActivityData.semesterCost = await pangu.spacing(structuredActivityData.semesterCost ?? "");
    structuredActivityData.semesterCost = structuredActivityData.semesterCost?.replaceAll("\n ", "\n") ?? "";
  } else {
    structuredActivityData.semesterCost = "";
  }
  // Determine if student-led
  if (structuredActivityData.name) {
    if (structuredActivityData.name.search("Student-led") !== -1 ||
        structuredActivityData.name.search("学生社团") !== -1 ||
        structuredActivityData.name.search("(SL)") !== -1) {
      structuredActivityData.isStudentLed = true;
    } else {
      structuredActivityData.isStudentLed = false;
    }
  }
  // Parse grades from schedule
  try {
    if (structuredActivityData.schedule) {
      let grades = structuredActivityData.schedule.match(/G(\d+)-(\d+)/) || 
                  structuredActivityData.schedule.match(/KG(\d+)-KG(\d+)/);
      
      if (!grades || grades.length < 3) {
        throw new Error('Invalid grade format in schedule');
      }
      const minGrade = grades[1];
      const maxGrade = grades[2];
      if (minGrade === undefined || maxGrade === undefined) {
          throw new Error('Invalid grade format in schedule');
      }
      structuredActivityData.grades.min = parseInt(minGrade).toString(10);
      structuredActivityData.grades.max = parseInt(maxGrade).toString(10);
    }
  } catch (error) {
    logger.error(`Failed to parse grades: ${(error as Error).message}`);
    structuredActivityData.grades.min = null;
    structuredActivityData.grades.max = null;
  }
}

export async function structActivityData(rawActivityData: RawActivityData): Promise<ActivityData> {
  let structuredActivityData: ActivityData = JSON.parse(JSON.stringify(clubSchema));
  let rows = rawActivityData.newRows;
  // Load club id - "rID": "3350:1:0:0"
  structuredActivityData.id = rows[0]?.rID?.split(":")[0] ?? null;
  
  for (const rowObject of rows) {
    for (let i = 0; i < rowObject.fields.length; i++) {
      const field = rowObject.fields[i];
      // Skip if no fData
      if (!field || !field.fData) { continue; }
      // Process hard cases first
      if (field.fData === "Description") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          structuredActivityData.description = rowObject.fields[i + 1].fData;
        }
        continue;
      } else if (field.fData === "Name To Appear On Reports") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          let staffForReports = rowObject.fields[i + 1].fData.split(", ");
          structuredActivityData.staffForReports = staffForReports;
        }
      } else if (field.fData === "Upload Photo") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          structuredActivityData.photo = rowObject.fields[i + 1].fData;
        }
      } else if (field.fData === "Poor Weather Plan") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          structuredActivityData.poorWeatherPlan = rowObject.fields[i + 1].fData;
        }
      } else if (field.fData === "Activity Runs From") {
        if (i + 4 < rowObject.fields.length && rowObject.fields[i + 4]) {
          structuredActivityData.duration.isRecurringWeekly = 
            rowObject.fields[i + 4].fData === "Recurring Weekly";
        }
      } else if (field.fData === "Is Pre Sign-up") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          structuredActivityData.isPreSignup = rowObject.fields[i + 1].fData !== "";
        }
      } else if (field.fData === "Semester Cost") {
        if (i + 1 < rowObject.fields.length && rowObject.fields[i + 1]) {
          structuredActivityData.semesterCost = 
            rowObject.fields[i + 1].fData === "" ? null : rowObject.fields[i + 1].fData;
        }
      } else {
        // Pass any other easy cases to helper function
        await applyFields(field, structuredActivityData);
      }
    }
  }
  await postProcess(structuredActivityData);
  return structuredActivityData;
}
