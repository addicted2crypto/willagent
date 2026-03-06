import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';

/**
 * Service for loading SKILL.md files that provide domain knowledge
 * to Hands. Skills are markdown files that get injected into the
 * LLM system prompt to provide context about:
 * - APIs and endpoints
 * - Contract addresses
 * - Analysis patterns
 * - Thresholds and rules
 */
@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);
  private readonly cache = new Map<string, string>();
  private readonly basePath: string;

  constructor() {
    // Skills are stored in src/skills/ relative to project root
    this.basePath = resolve(__dirname, '..', 'skills');
  }

  /**
   * Load a skill file from the given path.
   * Caches the content in memory for subsequent loads.
   *
   * @param skillPath - Relative path like "./skills/avax-chain-analysis.md"
   * @returns The skill content, or empty string if not found
   */
  async loadSkill(skillPath: string): Promise<string> {
    // Normalize the path
    const normalizedPath = skillPath.replace(/^\.\/skills\//, '').replace(/^skills\//, '');

    // Check cache first
    if (this.cache.has(normalizedPath)) {
      return this.cache.get(normalizedPath)!;
    }

    try {
      const fullPath = join(this.basePath, normalizedPath);
      const content = await readFile(fullPath, 'utf-8');

      // Cache the content
      this.cache.set(normalizedPath, content);
      this.logger.log(`Loaded skill: ${normalizedPath} (${content.length} chars)`);

      return content;
    } catch (error) {
      this.logger.warn(`Failed to load skill: ${normalizedPath}`, error);
      return '';
    }
  }

  /**
   * Clear the skill cache, forcing a reload on next access.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Skill cache cleared');
  }

  /**
   * Reload a specific skill, bypassing the cache.
   */
  async reloadSkill(skillPath: string): Promise<string> {
    const normalizedPath = skillPath.replace(/^\.\/skills\//, '').replace(/^skills\//, '');
    this.cache.delete(normalizedPath);
    return this.loadSkill(skillPath);
  }

  /**
   * Build a system prompt that includes the skill content.
   * The skill content is prepended to provide domain context.
   */
  buildSystemPromptWithSkill(basePrompt: string, skillContent: string): string {
    if (!skillContent) {
      return basePrompt;
    }

    return `# Domain Knowledge

${skillContent}

---

${basePrompt}`;
  }
}
