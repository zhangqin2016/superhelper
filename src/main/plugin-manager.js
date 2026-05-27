"use strict";

/**
 * Tracks which plugins are installed/enabled at global and per-project scope,
 * and builds the MCP config consumed by Claude CLI.
 */

const fs = require("node:fs");
const { mcpConfigPath } = require("./config");
const pluginRegistry = require("./plugin-registry");

class PluginManager {
  /**
   * @param {import('./project-manager')} projectManager
   */
  constructor(projectManager) {
    this.pm = projectManager;
  }

  enabledIds(project) {
    const ids = new Set();
    for (const [id, state] of Object.entries(this.pm.globalPlugins)) {
      if (state.enabled) ids.add(id);
    }
    for (const [id, state] of Object.entries(project.plugins)) {
      if (state.enabled) ids.add(id);
    }
    return [...ids];
  }

  hasEnabled(project, pluginId) {
    return this.enabledIds(project).includes(pluginId);
  }

  getMarketState() {
    const project = this.pm.getActive();
    return {
      activeProjectId: project.id,
      plugins: pluginRegistry.listAll().map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        packageName: plugin.packageName,
        scopes: plugin.scopes,
        permissions: plugin.permissions,
        global: this._stateFor(plugin.id, "global", project),
        workspace: this._stateFor(plugin.id, "workspace", project),
      })),
    };
  }

  install(pluginId, scope) {
    const plugin = pluginRegistry.findById(pluginId);
    if (!plugin || !plugin.scopes.includes(scope)) return false;
    const target = this._target(scope);
    target[pluginId] = { enabled: true, installedAt: new Date().toISOString() };
    this.pm.save();
    return true;
  }

  setEnabled(pluginId, scope, enabled) {
    const target = this._target(scope);
    if (!target[pluginId]) return false;
    target[pluginId].enabled = Boolean(enabled);
    this.pm.save();
    return true;
  }

  uninstall(pluginId, scope) {
    const target = this._target(scope);
    delete target[pluginId];
    this.pm.save();
  }

  writeMcpConfig(project) {
    const mcpServers = {};
    for (const pluginId of this.enabledIds(project)) {
      const plugin = pluginRegistry.findById(pluginId);
      if (plugin) {
        mcpServers[plugin.id] = plugin.server(project);
      }
    }
    const filePath = mcpConfigPath();
    fs.writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2));
    return filePath;
  }

  _target(scope) {
    return scope === "global" ? this.pm.globalPlugins : this.pm.getActive().plugins;
  }

  _stateFor(pluginId, scope, project) {
    const source = scope === "global" ? this.pm.globalPlugins : project.plugins;
    return source[pluginId] || null;
  }
}

module.exports = PluginManager;
