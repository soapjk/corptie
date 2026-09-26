export const BUILTIN_SCENE_TEMPLATES = Object.freeze([
  defineTemplate({
    templateId: "fitness-planner",
    version: 1,
    title: "健身规划",
    description: "规划训练、记录完成情况与身体指标。",
    recordTypes: {
      Plan: objectSchema({
        title: text(1, 120),
        startDate: date(),
        endDate: date(),
        goal: text(0, 500),
        status: enumeration(["draft", "active", "completed", "archived"])
      }, ["title", "startDate", "endDate", "status"]),
      WorkoutItem: objectSchema({
        planId: reference("Plan"),
        scheduledAt: dateTime(),
        exercise: text(1, 160),
        sets: integer(1, 100),
        durationMinutes: number(0, 1440),
        intensity: enumeration(["low", "moderate", "high"]),
        order: integer(0, 10000),
        completed: boolean()
      }, ["planId", "scheduledAt", "exercise", "order", "completed"]),
      WorkoutLog: objectSchema({
        workoutItemId: reference("WorkoutItem"),
        occurredAt: dateTime(),
        result: enumeration(["completed", "partial", "skipped"]),
        notes: text(0, 1000),
        exertion: number(0, 10)
      }, ["workoutItemId", "occurredAt", "result"]),
      Measurement: objectSchema({
        measuredAt: dateTime(),
        metric: text(1, 80),
        value: number(-1000000, 1000000),
        unit: text(1, 32),
        source: enumeration(["manual", "import"])
      }, ["measuredAt", "metric", "value", "unit", "source"]),
      Goal: objectSchema({
        metric: text(1, 80),
        targetValue: number(-1000000, 1000000),
        unit: text(1, 32),
        targetDate: date(),
        status: enumeration(["active", "achieved", "abandoned"])
      }, ["metric", "targetValue", "unit", "targetDate", "status"])
    },
    defaultViews: [
      { viewId: "today", title: "今日 / 本周", kind: "list", recordTypes: ["WorkoutItem"] },
      { viewId: "calendar", title: "周历", kind: "calendar", recordTypes: ["WorkoutItem", "WorkoutLog"] },
      { viewId: "goals", title: "目标进度", kind: "progress", recordTypes: ["Goal", "Measurement"] },
      { viewId: "measurements", title: "测量趋势", kind: "trend", recordTypes: ["Measurement"] }
    ],
    allowedActions: ["createRecord", "updateRecord", "completeItem", "archiveRecord", "batchApply"]
  }),
  defineTemplate({
    templateId: "daily-checklist",
    version: 1,
    title: "日常清单",
    description: "按清单和日期维护日常事项。",
    recordTypes: {
      List: objectSchema({ title: text(1, 120), archived: boolean() }, ["title", "archived"]),
      Item: objectSchema({
        listId: reference("List"),
        title: text(1, 240),
        dueAt: nullable(dateTime()),
        completed: boolean(),
        order: integer(0, 100000)
      }, ["listId", "title", "completed", "order"])
    },
    defaultViews: [
      { viewId: "checklist", title: "清单", kind: "list", recordTypes: ["List", "Item"] },
      { viewId: "calendar", title: "日历", kind: "calendar", recordTypes: ["Item"] }
    ],
    allowedActions: ["createRecord", "updateRecord", "completeItem", "archiveRecord", "batchApply"]
  })
]);

export function builtinSceneTemplate(templateId, version = 1) {
  return BUILTIN_SCENE_TEMPLATES.find(
    (template) => template.templateId === templateId && template.version === Number(version)
  ) ?? null;
}

function defineTemplate(template) {
  return deepFreeze({ ...template, migrationDefinitions: [], seedExamples: [] });
}

function objectSchema(properties, required) {
  return { type: "object", additionalProperties: false, properties, required };
}

function text(minLength, maxLength) {
  return { type: "string", minLength, maxLength };
}

function number(minimum, maximum) {
  return { type: "number", minimum, maximum };
}

function integer(minimum, maximum) {
  return { type: "integer", minimum, maximum };
}

function boolean() {
  return { type: "boolean" };
}

function date() {
  return { type: "string", format: "date" };
}

function dateTime() {
  return { type: "string", format: "date-time" };
}

function enumeration(values) {
  return { type: "string", enum: values };
}

function reference(recordType) {
  return { type: "string", format: "scene-reference", recordType };
}

function nullable(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
