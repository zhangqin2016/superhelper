"use strict";

/**
 * Manages local projects (directories) that serve as working directories
 * for assistant sessions. Persisted to userData/projects.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectsConfigPath } = require("./config");

const WORKSPACE_ORDER_VERSION = 1;

class ProjectManager {
  constructor(defaultPath) {
    this.defaultPath = defaultPath;
    this.projects = [];
    this.activeProjectId = null;
    this.workspaceOrderVersion = WORKSPACE_ORDER_VERSION;
  }

  load() {
    let freshInstall = false;
    let migrationRollback = null;
    let raw;
    try {
      raw = fs.readFileSync(projectsConfigPath(), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.projects = [];
      this.activeProjectId = null;
      this.workspaceOrderVersion = WORKSPACE_ORDER_VERSION;
      freshInstall = true;
    }

    if (!freshInstall) {
      const parsed = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (Object.hasOwn(parsed, "projects") && !Array.isArray(parsed.projects))
      ) {
        const error = new Error("INVALID_PROJECTS_CONFIG");
        error.code = "INVALID_PROJECTS_CONFIG";
        throw error;
      }
      const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
      const persistedOrderVersion = Number(parsed.workspaceOrderVersion);
      const needsOrderMigration =
        !Number.isFinite(persistedOrderVersion) ||
        persistedOrderVersion < WORKSPACE_ORDER_VERSION;
      const orderedProjects = needsOrderMigration
        ? [
            ...rawProjects.filter((project) => Boolean(project?.pinned)),
            ...rawProjects.filter((project) => !project?.pinned),
          ]
        : rawProjects;

      this.projects = orderedProjects.map((project) =>
        this._normalize(project),
      );
      this.activeProjectId = parsed.activeProjectId ?? null;
      this.workspaceOrderVersion = needsOrderMigration
        ? WORKSPACE_ORDER_VERSION
        : persistedOrderVersion;

      if (needsOrderMigration) {
        migrationRollback = {
          projects: rawProjects,
          activeProjectId: this.activeProjectId,
          workspaceOrderVersion: parsed.workspaceOrderVersion,
        };
      }
    }

    if (migrationRollback) {
      try {
        this.save();
      } catch (error) {
        this.projects = migrationRollback.projects;
        this.activeProjectId = migrationRollback.activeProjectId;
        this.workspaceOrderVersion = migrationRollback.workspaceOrderVersion;
        throw error;
      }
    }

    this._sanitizeProjectPaths();

    // First launch only — user may intentionally delete all workspaces later.
    if (freshInstall && this.projects.length === 0) {
      const project = this._create(this._ensureDefaultWorkspaceDir());
      this.projects = [project];
      this.activeProjectId = project.id;
      this.save();
    }

    if (this.projects.length === 0) {
      this.activeProjectId = null;
    } else if (!this.projects.some((p) => p.id === this.activeProjectId)) {
      this.activeProjectId = this.projects[0].id;
      this.save();
    }
  }

  /** Packaged app used app.asar as defaultPath in older builds — repair on load. */
  _isValidProjectPath(projectPath) {
    if (!projectPath || typeof projectPath !== "string") return false;
    const normalized = projectPath.replace(/\\/g, "/").toLowerCase();
    if (normalized.includes(".asar")) return false;
    if (normalized.includes("/resources/app/")) return false;
    try {
      if (!fs.existsSync(projectPath)) return false;
      return fs.statSync(projectPath).isDirectory();
    } catch {
      return false;
    }
  }

  _ensureDefaultWorkspaceDir() {
    fs.mkdirSync(this.defaultPath, { recursive: true });
    return this.defaultPath;
  }

  _sanitizeProjectPaths() {
    let changed = false;
    for (const project of this.projects) {
      if (this._isValidProjectPath(project.path)) continue;
      const fallback = this._ensureDefaultWorkspaceDir();
      console.warn(
        `[projects] invalid workspace path "${project.path}" → "${fallback}"`,
      );
      project.path = fallback;
      const baseName = path.basename(fallback);
      if (
        !project.name ||
        project.name.includes(".asar") ||
        project.name === "resources"
      ) {
        project.name = baseName;
      }
      changed = true;
    }
    if (changed) this.save();
  }

  save() {
    const configPath = projectsConfigPath();
    const dir = path.dirname(configPath);
    const tempPath = `${configPath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        tempPath,
        JSON.stringify(
          {
            workspaceOrderVersion: this.workspaceOrderVersion,
            activeProjectId: this.activeProjectId,
            projects: this.projects,
          },
          null,
          2,
        ),
        "utf8",
      );
      fs.renameSync(tempPath, configPath);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }

  getActive() {
    if (this.projects.length === 0) return null;
    return (
      this.projects.find((p) => p.id === this.activeProjectId) ||
      this.projects[0]
    );
  }

  getAppState() {
    return {
      activeProjectId: this.activeProjectId,
      projects: this.projects.map((project) => this._summary(project)),
    };
  }

  find(projectId) {
    return this.projects.find((p) => p.id === projectId) || null;
  }

  add(projectPath) {
    if (!this._isValidProjectPath(projectPath)) {
      throw new Error("INVALID_WORKDIR");
    }
    let project = this.projects.find((p) => p.path === projectPath);
    if (!project) {
      project = this._create(projectPath);
      this.projects.unshift(project);
    }
    this.activeProjectId = project.id;
    this.save();
    return project;
  }

  /** True when this path is already a registered workspace. */
  hasPath(projectPath) {
    return this.projects.some((p) => p.path === projectPath);
  }

  switchTo(projectId) {
    const project = this.find(projectId);
    if (!project) return false;
    this.activeProjectId = project.id;
    this.save();
    return true;
  }

  rename(projectId, name) {
    const project = this.find(projectId);
    if (!project || !name) return false;
    project.name = name.slice(0, 60);
    this.save();
    return true;
  }

  reorder(projectIds) {
    const projectsById = new Map(
      this.projects.map((project) => [project.id, project]),
    );
    const uniqueIds = Array.isArray(projectIds)
      ? new Set(projectIds)
      : new Set();
    const valid =
      Array.isArray(projectIds) &&
      projectIds.length === this.projects.length &&
      uniqueIds.size === this.projects.length &&
      projectsById.size === this.projects.length &&
      projectIds.every((projectId) => projectsById.has(projectId));

    if (!valid) {
      const error = new Error("INVALID_PROJECT_ORDER");
      error.code = "INVALID_PROJECT_ORDER";
      throw error;
    }

    const previousProjects = this.projects;
    this.projects = projectIds.map((projectId) => projectsById.get(projectId));
    try {
      this.save();
    } catch (error) {
      this.projects = previousProjects;
      throw error;
    }
    return { ok: true };
  }

  remove(projectId) {
    const index = this.projects.findIndex((p) => p.id === projectId);
    if (index === -1) return "NOT_FOUND";
    this.projects.splice(index, 1);
    if (this.projects.length === 0) {
      this.activeProjectId = null;
    } else if (this.activeProjectId === projectId) {
      this.activeProjectId = this.projects[Math.max(0, index - 1)].id;
    }
    this.save();
    return "OK";
  }

  _create(projectPath) {
    return {
      id: crypto.randomUUID(),
      name: path.basename(projectPath) || projectPath,
      path: projectPath,
    };
  }

  _normalize(project) {
    const normalized = { ...project };
    delete normalized.pinned;
    normalized.id = normalized.id || crypto.randomUUID();
    const pathOk = this._isValidProjectPath(normalized.path);
    normalized.path = pathOk ? normalized.path : this.defaultPath;
    normalized.name =
      normalized.name ||
      path.basename(normalized.path || this.defaultPath);
    return normalized;
  }

  _summary(project) {
    const summary = {
      id: project.id,
      name: project.name,
      path: project.path,
    };
    try {
      const workspaceApp = require("./workspace-app-runtime").readWorkspaceAppRuntime(project.path);
      if (workspaceApp) summary.workspaceApp = workspaceApp;
    } catch {
      // Project summaries must stay available even if an app manifest is corrupt.
    }
    return summary;
  }
}

module.exports = ProjectManager;
