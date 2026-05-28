"use strict";

/**
 * Manages local projects (directories) that serve as working directories
 * for Claude CLI sessions. Persisted to userData/projects.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectsConfigPath } = require("./config");

class ProjectManager {
  constructor(defaultPath) {
    this.defaultPath = defaultPath;
    this.projects = [];
    this.activeProjectId = null;
  }

  load() {
    let freshInstall = false;
    try {
      const raw = fs.readFileSync(projectsConfigPath(), "utf8");
      const parsed = JSON.parse(raw);
      this.projects = Array.isArray(parsed.projects)
        ? parsed.projects.map((p) => this._normalize(p))
        : [];
      this.activeProjectId = parsed.activeProjectId ?? null;
    } catch {
      this.projects = [];
      freshInstall = true;
    }

    // First launch only — user may intentionally delete all workspaces later.
    if (freshInstall && this.projects.length === 0) {
      const project = this._create(this.defaultPath);
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

  save() {
    const dir = path.dirname(projectsConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      projectsConfigPath(),
      JSON.stringify(
        {
          activeProjectId: this.activeProjectId,
          projects: this.projects,
        },
        null,
        2,
      ),
    );
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
      projects: [...this.projects]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned))
        .map((p) => this._summary(p)),
    };
  }

  find(projectId) {
    return this.projects.find((p) => p.id === projectId) || null;
  }

  add(projectPath) {
    let project = this.projects.find((p) => p.path === projectPath);
    if (!project) {
      project = this._create(projectPath);
      this.projects.push(project);
    }
    this.activeProjectId = project.id;
    this.save();
    return project;
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

  togglePin(projectId) {
    const project = this.find(projectId);
    if (!project) return false;
    project.pinned = !project.pinned;
    this.save();
    return true;
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
      pinned: false,
    };
  }

  _normalize(project) {
    project.id = project.id || crypto.randomUUID();
    project.name =
      project.name || path.basename(project.path || this.defaultPath);
    project.path = project.path || this.defaultPath;
    project.pinned = Boolean(project.pinned);
    return project;
  }

  _summary(project) {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      pinned: Boolean(project.pinned),
    };
  }
}

module.exports = ProjectManager;
