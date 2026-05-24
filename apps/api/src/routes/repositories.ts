import { Hono } from "hono";
import { db, users, repositories, stars, repoBranchMetadata, organizations, organizationMembers } from "@sigmagit/db";
import { eq, sql, desc, and, inArray } from "drizzle-orm";
import git from "isomorphic-git";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { writeRateLimit } from "../middleware/rate-limit";
import { parseLimit, parseOffset } from "../lib/validation";
import { canAccessRepository } from "../lib/access";
import { resolveRepositoryBySlug, getStorageOwnerId, invalidateRepositorySlugCache } from "../lib/repo-helpers";
import { putObject, deletePrefix, getRepoPrefix, copyPrefix, listObjects } from "../s3";
import { repoCache } from "../redis";
import { createGitStore } from "../git";

const app = new Hono<{ Variables: AuthVariables }>();

const REPOSITORY_VISIBILITIES = ["public", "private"] as const;
type RepositoryVisibility = (typeof REPOSITORY_VISIBILITIES)[number];

const LICENSES = [
  "mit",
  "apache-2.0",
  "gpl-3.0",
  "agpl-3.0",
  "lgpl-3.0",
  "mpl-2.0",
  "bsd-3-clause",
  "unlicense",
] as const;
type LicenseType = (typeof LICENSES)[number];

function isRepositoryVisibility(value: unknown): value is RepositoryVisibility {
  return typeof value === "string" && REPOSITORY_VISIBILITIES.includes(value as RepositoryVisibility);
}

function getLicenseTemplate(license: LicenseType, year: number, holder: string): string {
  if (license === "mit") {
    return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
  }

  if (license === "apache-2.0") {
    return `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Copyright ${year} ${holder}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`;
  }

  if (license === "gpl-3.0") {
    return `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (C) ${year} ${holder}

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
`;
  }

  if (license === "agpl-3.0") {
    return `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007

Copyright (C) ${year} ${holder}

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
`;
  }

  if (license === "lgpl-3.0") {
    return `GNU LESSER GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (C) ${year} ${holder}

This library is free software; you can redistribute it and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 3 of the License, or (at your option) any later version.

This library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this library. If not, see <https://www.gnu.org/licenses/>.
`;
  }

  if (license === "mpl-2.0") {
    return `Mozilla Public License Version 2.0

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.

Copyright (c) ${year} ${holder}
`;
  }

  if (license === "bsd-3-clause") {
    return `BSD 3-Clause License

Copyright (c) ${year}, ${holder}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
  }

  return `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
`;
}

async function getForkCount(repoId: string): Promise<number> {
  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(repositories)
    .where(eq(repositories.forkedFromId, repoId));
  return Number(countRow?.count) || 0;
}

async function getForkedFromInfo(forkedFromId: string | null, currentUserId?: string) {
  if (!forkedFromId) {
    return null;
  }

  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      visibility: repositories.visibility,
      ownerId: repositories.ownerId,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(repositories.id, forkedFromId))
    .limit(1);

  if (!row) {
    return null;
  }

  const userObj = currentUserId ? { id: currentUserId } : null;
  if (!(await canAccessRepository({ id: row.id, ownerId: row.ownerId, visibility: row.visibility }, userObj))) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    owner: {
      id: row.ownerId,
      username: row.username,
      name: row.userName,
      avatarUrl: row.avatarUrl,
    },
  };
}

app.post("/api/repositories", requireAuth, writeRateLimit, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    name: string;
    description?: string;
    visibility: RepositoryVisibility;
    organizationId?: string;
    license?: LicenseType;
  }>();

  const normalizedName = body.name.toLowerCase().replace(/ /g, "-");

  if (!/^[a-zA-Z0-9_.-]+$/.test(normalizedName)) {
    return c.json({ error: "Invalid repository name" }, 400);
  }

  if (!isRepositoryVisibility(body.visibility)) {
    return c.json({ error: "Invalid repository visibility" }, 400);
  }

  if (body.license && !LICENSES.includes(body.license)) {
    return c.json({ error: "Unsupported license type" }, 400);
  }

  // If organizationId is provided, verify user has permission
  let ownerId = user.id;
  if (body.organizationId) {
    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, body.organizationId),
          eq(organizationMembers.userId, user.id)
        )
      );
    
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return c.json({ error: "You don't have permission to create repositories in this organization" }, 403);
    }
    ownerId = body.organizationId; // Use org ID as owner for storage prefix
  }

  const existing = await db.query.repositories.findFirst({
    where: and(
      body.organizationId 
        ? eq(repositories.organizationId, body.organizationId)
        : eq(repositories.ownerId, user.id),
      eq(repositories.name, normalizedName)
    ),
  });

  if (existing) {
    return c.json({ error: "Repository already exists" }, 400);
  }

  const [repo] = await db
    .insert(repositories)
    .values({
      name: normalizedName,
      description: body.description,
      visibility: body.visibility,
      ownerId: user.id, // Always set to user ID for ownership tracking
      organizationId: body.organizationId || null,
    })
    .returning();

  // Use organization name for storage if org repo, otherwise user ID
  const storageOwnerId = body.organizationId ? body.organizationId : user.id;
  const repoPrefix = getRepoPrefix(storageOwnerId, normalizedName);
  await putObject(`${repoPrefix}/HEAD`, "ref: refs/heads/main\n");
  await putObject(`${repoPrefix}/config`, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
  await putObject(`${repoPrefix}/description`, "Unnamed repository; edit this file to name the repository.\n");

  if (body.license) {
    const store = createGitStore(storageOwnerId, normalizedName);
    const now = new Date();
    const holder = user.name || user.username || "repository owner";
    const licenseContent = getLicenseTemplate(body.license, now.getFullYear(), holder);
    const licenseBlobOid = await git.writeBlob({
      fs: store.fs,
      dir: store.dir,
      blob: new TextEncoder().encode(licenseContent),
    });
    const rootTreeOid = await git.writeTree({
      fs: store.fs,
      dir: store.dir,
      tree: [{ path: "LICENSE", mode: "100644", type: "blob", oid: licenseBlobOid }],
    });
    const timestamp = Math.floor(now.getTime() / 1000);
    const timezoneOffset = now.getTimezoneOffset();
    const authorEmail = user.gitEmail || user.email;
    const initialCommitOid = await git.writeCommit({
      fs: store.fs,
      dir: store.dir,
      commit: {
        message: `Add ${body.license.toUpperCase()} license`,
        tree: rootTreeOid,
        parent: [],
        author: { name: holder, email: authorEmail, timestamp, timezoneOffset },
        committer: { name: holder, email: authorEmail, timestamp, timezoneOffset },
      },
    });
    await store.fs.promises.writeFile("refs/heads/main", `${initialCommitOid}\n`);
  }

  return c.json(repo);
});

app.post("/api/repositories/:owner/:name/fork", requireAuth, writeRateLimit, async (c) => {
  const user = c.get("user")!;
  const owner = c.req.param("owner");
  const name = c.req.param("name").replace(/\.git$/, "");
  const body = await c.req.json<{ name?: string; description?: string }>().catch(() => ({}));

  const sourceResult = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      organizationId: repositories.organizationId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      forkedFromId: repositories.forkedFromId,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const source = sourceResult[0];
  if (!source) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (source.visibility === "private" && user.id !== source.ownerId) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const existingFork = await db.query.repositories.findFirst({
    where: and(eq(repositories.ownerId, user.id), eq(repositories.forkedFromId, source.id)),
  });

  if (existingFork) {
    const [starCount] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(stars)
      .where(eq(stars.repositoryId, existingFork.id));

    const existingStar = await db.query.stars.findFirst({
      where: and(eq(stars.userId, user.id), eq(stars.repositoryId, existingFork.id)),
    });

    const forkedFrom = await getForkedFromInfo(existingFork.forkedFromId, user.id);
    const forkCount = await getForkCount(existingFork.id);

    return c.json({
      repo: {
        id: existingFork.id,
        name: existingFork.name,
        description: existingFork.description,
        visibility: existingFork.visibility,
        defaultBranch: existingFork.defaultBranch,
        createdAt: existingFork.createdAt,
        updatedAt: existingFork.updatedAt,
        ownerId: existingFork.ownerId,
        owner: {
          id: user.id,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        starCount: Number(starCount?.count) || 0,
        starred: !!existingStar,
        forkedFrom,
        forkCount,
      },
      isOwner: true,
    });
  }

  const targetName = ("name" in body && body.name ? body.name : source.name).toLowerCase().replace(/ /g, "-");

  if (!/^[a-zA-Z0-9_.-]+$/.test(targetName)) {
    return c.json({ error: "Invalid repository name" }, 400);
  }

  const existingName = await db.query.repositories.findFirst({
    where: and(eq(repositories.ownerId, user.id), eq(repositories.name, targetName)),
  });

  if (existingName) {
    return c.json({ error: "Repository with this name already exists" }, 400);
  }

  const [forkRepo] = await db
    .insert(repositories)
    .values({
      name: targetName,
      description: ("description" in body ? body.description : source.description) ?? null,
      visibility: "public",
      ownerId: user.id,
      forkedFromId: source.id,
    })
    .returning();

  const sourcePrefix = getRepoPrefix(getStorageOwnerId(source), source.name);
  const targetPrefix = getRepoPrefix(user.id, targetName);
  await copyPrefix(sourcePrefix, targetPrefix);

  const sourceMetadata = await db.query.repoBranchMetadata.findMany({
    where: eq(repoBranchMetadata.repoId, source.id),
  });

  if (sourceMetadata.length > 0) {
    await db.insert(repoBranchMetadata).values(
      sourceMetadata.map((row) => ({
        repoId: forkRepo.id,
        branch: row.branch,
        headOid: row.headOid,
        commitCount: row.commitCount,
        lastCommitOid: row.lastCommitOid,
        lastCommitMessage: row.lastCommitMessage,
        lastCommitAuthorName: row.lastCommitAuthorName,
        lastCommitAuthorEmail: row.lastCommitAuthorEmail,
        lastCommitTimestamp: row.lastCommitTimestamp,
        readmeOid: row.readmeOid,
        rootTree: row.rootTree,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    );
  }

  const forkedFrom = await getForkedFromInfo(source.id, user.id);

  return c.json({
    repo: {
      id: forkRepo.id,
      name: forkRepo.name,
      description: forkRepo.description,
      visibility: forkRepo.visibility,
      defaultBranch: forkRepo.defaultBranch,
      createdAt: forkRepo.createdAt,
      updatedAt: forkRepo.updatedAt,
      ownerId: forkRepo.ownerId,
      owner: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      starCount: 0,
      starred: false,
      forkedFrom,
      forkCount: 0,
    },
    isOwner: true,
  });
});

app.get("/api/repositories/public", async (c) => {
  const sortBy = c.req.query("sortBy") || "updated";
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const orderBy =
    sortBy === "stars"
      ? desc(sql`star_count`)
      : sortBy === "created"
        ? desc(repositories.createdAt)
        : desc(repositories.updatedAt);

  const result = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
      starCount: sql<number>`(SELECT COUNT(*) FROM stars WHERE repository_id = ${repositories.id})`.as("star_count"),
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(repositories.visibility, "public"))
    .orderBy(orderBy)
    .limit(limit + 1)
    .offset(offset);

  const hasMore = result.length > limit;
  const rows = result.slice(0, limit);
  const repoIds = rows.map((r) => r.id);

  let starredRepoIds = new Set<string>();
  const currentUser = c.get("user");
  if (currentUser && repoIds.length > 0) {
    const starredRows = await db
      .select({ repositoryId: stars.repositoryId })
      .from(stars)
      .where(and(eq(stars.userId, currentUser.id), inArray(stars.repositoryId, repoIds)));
    starredRepoIds = new Set(starredRows.map((r) => r.repositoryId));
  }

  const repos = rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: {
      id: row.ownerId,
      username: row.username,
      name: row.userName,
      avatarUrl: row.avatarUrl,
    },
    starCount: Number(row.starCount) || 0,
    ...(currentUser && { starredByViewer: starredRepoIds.has(row.id) }),
  }));

  return c.json({ repos, hasMore });
});

app.get("/api/repositories/user/:username", async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  const userResult = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: { id: true, username: true, name: true, avatarUrl: true },
  });

  if (!userResult) {
    return c.json({ repos: [] });
  }

  const isOwner = currentUser?.id === userResult.id;

  const reposResult = await db.query.repositories.findMany({
    where: isOwner
      ? eq(repositories.ownerId, userResult.id)
      : and(eq(repositories.ownerId, userResult.id), eq(repositories.visibility, "public")),
    orderBy: desc(repositories.updatedAt),
  });

  if (reposResult.length === 0) {
    return c.json({ repos: [] });
  }

  const repoIds = reposResult.map((r) => r.id);
  const countRows = await db
    .select({
      repositoryId: stars.repositoryId,
      count: sql<number>`COUNT(*)::int`.as("cnt"),
    })
    .from(stars)
    .where(inArray(stars.repositoryId, repoIds))
    .groupBy(stars.repositoryId);

  const countByRepoId = new Map<string, number>();
  for (const row of countRows) {
    countByRepoId.set(row.repositoryId, Number(row.count) || 0);
  }

  let starredRepoIds = new Set<string>();
  if (currentUser && repoIds.length > 0) {
    const starredRows = await db
      .select({ repositoryId: stars.repositoryId })
      .from(stars)
      .where(and(eq(stars.userId, currentUser.id), inArray(stars.repositoryId, repoIds)));
    starredRepoIds = new Set(starredRows.map((r) => r.repositoryId));
  }

  const reposWithStars = reposResult.map((repo) => ({
    ...repo,
    owner: {
      id: userResult.id,
      username: userResult.username,
      name: userResult.name,
      avatarUrl: userResult.avatarUrl,
    },
    starCount: countByRepoId.get(repo.id) ?? 0,
    ...(currentUser && { starredByViewer: starredRepoIds.has(repo.id) }),
  }));

  return c.json({ repos: reposWithStars });
});

app.post("/api/repositories/:id/star", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const existing = await db.query.stars.findFirst({
    where: and(eq(stars.userId, user.id), eq(stars.repositoryId, id)),
  });

  if (existing) {
    await db.delete(stars).where(and(eq(stars.userId, user.id), eq(stars.repositoryId, id)));
    return c.json({ starred: false });
  } else {
    await db.insert(stars).values({
      userId: user.id,
      repositoryId: id,
    });
    return c.json({ starred: true });
  }
});

app.get("/api/repositories/:id/is-starred", async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  if (!currentUser) {
    return c.json({ starred: false });
  }

  const existing = await db.query.stars.findFirst({
    where: and(eq(stars.userId, currentUser.id), eq(stars.repositoryId, id)),
  });

  return c.json({ starred: !!existing });
});

app.get("/api/repositories/:owner/:name", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const resolved = await resolveRepositoryBySlug(owner, name);
  if (!resolved) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!(await canAccessRepository(resolved, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const row = await db.query.repositories.findFirst({
    where: eq(repositories.id, resolved.id),
  });

  if (!row) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [starCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(stars)
    .where(eq(stars.repositoryId, row.id));

  const forkedFrom = await getForkedFromInfo(row.forkedFromId, currentUser?.id);
  const forkCount = await getForkCount(row.id);

  let avatarUrl: string | null = null;
  if (resolved.ownerType === "org" && resolved.organizationId) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, resolved.organizationId),
      columns: { avatarUrl: true },
    });
    avatarUrl = org?.avatarUrl ?? null;
  } else {
    const ownerUser = await db.query.users.findFirst({
      where: eq(users.id, resolved.ownerId),
      columns: { avatarUrl: true },
    });
    avatarUrl = ownerUser?.avatarUrl ?? null;
  }

  return c.json({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: {
      id: resolved.ownerType === "org" ? resolved.organizationId! : resolved.ownerId,
      username: resolved.ownerSlug,
      name: resolved.ownerDisplay,
      avatarUrl,
    },
    starCount: Number(starCount?.count) || 0,
    forkedFrom,
    forkCount,
  });
});

app.get("/api/repositories/:owner/:name/with-stars", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const result = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      forkedFromId: repositories.forkedFromId,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const row = result[0];
  if (!row) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!(await canAccessRepository({ id: row.id, ownerId: row.ownerId, visibility: row.visibility }, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [starCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(stars)
    .where(eq(stars.repositoryId, row.id));

  let starred = false;
  if (currentUser) {
    const existing = await db.query.stars.findFirst({
      where: and(eq(stars.userId, currentUser.id), eq(stars.repositoryId, row.id)),
    });
    starred = !!existing;
  }

  const forkedFrom = await getForkedFromInfo(row.forkedFromId, currentUser?.id);
  const forkCount = await getForkCount(row.id);

  return c.json({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    owner: {
      id: row.ownerId,
      username: row.username,
      name: row.userName,
      avatarUrl: row.avatarUrl,
    },
    starCount: Number(starCount?.count) || 0,
    starred,
    forkedFrom,
    forkCount,
  });
});

app.get("/api/repositories/:owner/:name/forks", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const sourceResult = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const source = sourceResult[0];
  if (!source) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!(await canAccessRepository({ id: source.id, ownerId: source.ownerId, visibility: source.visibility }, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const forkRows = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(repositories.forkedFromId, source.id))
    .orderBy(desc(repositories.updatedAt))
    .limit(limit)
    .offset(offset);

  const forks = await Promise.all(
    forkRows.map(async (row) => {
      const [starCount] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(stars)
        .where(eq(stars.repositoryId, row.id));

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        defaultBranch: row.defaultBranch,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ownerId: row.ownerId,
        owner: {
          id: row.ownerId,
          username: row.username,
          name: row.userName,
          avatarUrl: row.avatarUrl,
        },
        starCount: Number(starCount?.count) || 0,
      };
    })
  );

  return c.json({ forks });
});

app.delete("/api/repositories/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
  });

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (repo.ownerId !== user.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  console.log(`[API] Deleting repository ${user.id}/${repo.name}`);
  const repoPrefix = getRepoPrefix(user.id, repo.name);

  const keys = await listObjects(repoPrefix);
  console.log(`[API] Found ${keys.length} objects to delete`);

  await deletePrefix(repoPrefix);
  console.log(`[API] Deleted all objects for repository`);

  await repoCache.invalidateRepo(getStorageOwnerId(repo), repo.name);
  const owner = await db.query.users.findFirst({
    where: eq(users.id, repo.ownerId),
    columns: { username: true },
  });
  if (owner?.username) {
    await invalidateRepositorySlugCache(owner.username, repo.name);
  }
  if (repo.organizationId) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, repo.organizationId),
      columns: { name: true },
    });
    if (org?.name) {
      await invalidateRepositorySlugCache(org.name, repo.name);
    }
  }
  console.log(`[API] Invalidated Redis cache for repository`);

  await db.delete(repositories).where(eq(repositories.id, id));
  console.log(`[API] Deleted repository record`);

  return c.json({ success: true });
});

app.patch("/api/repositories/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: RepositoryVisibility;
  }>();

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
  });

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (repo.ownerId !== user.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const newName = body.name ? body.name.toLowerCase().replace(/ /g, "-") : repo.name;
  const nextVisibility = body.visibility ?? repo.visibility;

  if (body.visibility !== undefined && !isRepositoryVisibility(body.visibility)) {
    return c.json({ error: "Invalid repository visibility" }, 400);
  }

  if (body.name) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(newName)) {
      return c.json({ error: "Invalid repository name" }, 400);
    }

    if (newName !== repo.name) {
      const existing = await db.query.repositories.findFirst({
        where: and(eq(repositories.ownerId, user.id), eq(repositories.name, newName)),
      });

      if (existing) {
        return c.json({ error: "Repository with this name already exists" }, 400);
      }
    }
  }

  const [updated] = await db
    .update(repositories)
    .set({
      name: newName,
      description: body.description ?? repo.description,
      visibility: nextVisibility,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, id))
    .returning();

  if (newName !== repo.name || nextVisibility !== repo.visibility) {
    await repoCache.invalidateRepo(getStorageOwnerId(repo), repo.name);
    const owner = await db.query.users.findFirst({
      where: eq(users.id, repo.ownerId),
      columns: { username: true },
    });
    if (owner?.username) {
      await invalidateRepositorySlugCache(owner.username, repo.name);
      if (newName !== repo.name) {
        await invalidateRepositorySlugCache(owner.username, newName);
      }
    }
    if (repo.organizationId) {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, repo.organizationId),
        columns: { name: true },
      });
      if (org?.name) {
        await invalidateRepositorySlugCache(org.name, repo.name);
        if (newName !== repo.name) {
          await invalidateRepositorySlugCache(org.name, newName);
        }
      }
    }
  }

  return c.json(updated);
});

export default app;
