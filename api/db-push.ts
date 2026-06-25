import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";

export const dbPushRouter = createRouter({
  push: publicQuery.mutation(async () => {
    const db = getDb();
    
    // Create shared_sessions table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS shared_sessions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        session_key VARCHAR(100) NOT NULL UNIQUE,
        type ENUM('collaboration','handoff','meeting','review','adhoc') DEFAULT 'adhoc' NOT NULL,
        status ENUM('active','archived') DEFAULT 'active' NOT NULL,
        participants TEXT,
        summary TEXT,
        context TEXT,
        created_by BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Create session_messages table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id BIGINT NOT NULL,
        from_agent_id BIGINT,
        to_agent_id BIGINT,
        role ENUM('user','assistant','system') DEFAULT 'assistant' NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // Create agent_memories table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        agent_id BIGINT NOT NULL,
        \`key\` VARCHAR(100) NOT NULL,
        \`value\` TEXT NOT NULL,
        type ENUM('personal','shared','company') DEFAULT 'personal' NOT NULL,
        tags VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
        UNIQUE KEY uq_agent_memories_key (agent_id, \`key\`)
      )
    `);

    // Create external_agents table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS external_agents (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        platform ENUM('hermes','opencode','codex','arkclaw','openai','custom') NOT NULL,
        endpoint VARCHAR(500),
        api_key VARCHAR(500),
        model VARCHAR(100),
        status ENUM('online','offline','error') DEFAULT 'offline' NOT NULL,
        capabilities TEXT,
        config TEXT,
        last_heartbeat TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
      )
    `);

    return { success: true, tables: ["shared_sessions", "session_messages", "agent_memories", "external_agents"] };
  }),
});
