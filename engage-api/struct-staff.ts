// ./engage-api/struct-staff.ts
import { logger } from '../utils/logger';

// Define interfaces
interface Staff {
  key: string;
  val: string;
}

interface ActivityField {
  fID: string;
  fData?: string;
  lParms?: Staff[];
}

interface ActivityRow {
  fields: ActivityField[];
}

interface RawActivityData {
  newRows: ActivityRow[];
}

// Using a Map for staff data
const staffs: Map<string, string> = new Map();

/**
 * Filters out blacklisted staff keys and corrects odd name formats
 * @param staffsMap - Map of staff IDs to names
 * @returns Cleaned staff map
 */
async function dropOddName(staffsMap: Map<string, string>): Promise<Map<string, string>> {
  const blackList: string[] = [
    "CL1-827", "CL1-831", "ID: CL1-832", "CL1-834",
    "CL1-835", "CL1-836", "CL1-838", "CL1-842", "CL1-843",
    "CL1-844", "CL1-845", "CL1-846"
  ];
  
  const oddNames: Record<string, string> = {
    "Mr TT15 Pri KinLiu TT15 Pri KinLiu": "Mr Kin Liu",
    "Mr TT13 Yanni Shen TT13 Yanni Shen": "Mr Yanni Shen",
    "Mr TT19 Pri Saima Salem TT19 Pri Saima Salem": "Mr Saima Salem",
    "Ms TT Ca(CCA) TT Ma": "Ms Ca Ma", 
    "Mr JackyT JackyT": "Mr JackyT",
    "Ms TT Ma TT M": "Ms Ma M", 
    "TT01 Fang TT01 Dong": "Mr Fang Dong",
    "Mr TT18 Shane Rose TT18 Shane Rose": "Mr Shane Rose",
    "Ms Caroline Malone(id)": "Ms Caroline Malone",
    "Ms Marina Mao(id)": "Ms Marina Mao",
    "Mrs Amy Yuan (Lower Secondary Secretary初中部学部助理)": "Mrs Amy Yuan",
    "Ms Lily Liu (Primary)": "Ms Lily Liu", 
    "Ms Cindy 薛": "Ms Cindy Xue",
    "Ms SiSi Li": "Ms Sisi Li"
  };
  
  // Filter out blacklisted keys
  for (const key of blackList) {
    staffsMap.delete(key);
  }
  
  // Update odd names
  for (const [originalName, correctedName] of Object.entries(oddNames)) {
    for (const [id, name] of staffsMap.entries()) {
      if (name === originalName) {
        staffsMap.set(id, correctedName);
      }
    }
  }
  
  return staffsMap;
}

/**
 * Updates the staff map with new staff data
 * @param staffsMap - Existing map of staff IDs to names
 * @param lParms - Array of staff objects with key/value pairs
 * @returns Updated staff map
 */
async function updateStaffMap(
  staffsMap: Map<string, string>, 
  lParms?: Staff[]
): Promise<Map<string, string>> {
  if (!lParms) {
    return staffsMap;
  }
  
  for (const staff of lParms) {
    if (staff && staff.key) {
      staffsMap.set(staff.key, staff.val || "");
    }
  }
  
  return await dropOddName(staffsMap);
}

/**
 * Structures staff data from raw activity data
 * @param rawActivityData - Raw activity data from API
 * @returns Map of staff IDs to names
 */
export async function structStaffData(rawActivityData: RawActivityData): Promise<Map<string, string>> {
  const rows = rawActivityData.newRows;
  
  for (const rowObject of rows) {
    for (const field of rowObject.fields) {
      if (field.fID === "staff") {
        return await updateStaffMap(staffs, field.lParms);
      }
    }
  }
  
  // Return the staff map even if no updates were made
  return staffs;
}
