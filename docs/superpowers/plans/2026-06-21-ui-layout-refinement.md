# UI Layout Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the mini-program UI around the approved map-workbench homepage and align supporting pages.

**Architecture:** This is a WXML/WXSS-first change. Existing JavaScript behavior is preserved unless a small state field is needed to make the layout clearer.

**Tech Stack:** WeChat Mini Program WXML/WXSS, Node-based structural tests in `scripts/run-tests.js`.

---

### Task 1: Add Structural UI Guard

**Files:**
- Modify: `scripts/run-tests.js`

- [ ] Add a test that reads the page WXML files and asserts the approved layout classes exist.
- [ ] Run `npm test` and confirm the test fails against the old layout.

### Task 2: Refine Homepage

**Files:**
- Modify: `pages/index/index.wxml`
- Modify: `pages/index/index.wxss`

- [ ] Replace the duplicate collapsed/expanded config controls with a single compact workbench config row.
- [ ] Add a first recommendation preview in collapsed state.
- [ ] Keep expanded controls and recommendation list usable without duplicating the collapsed controls.
- [ ] Run `npm test` and confirm homepage structure assertions pass.

### Task 3: Align Supporting Pages

**Files:**
- Modify: `pages/detail/detail.wxml`
- Modify: `pages/detail/detail.wxss`
- Modify: `pages/vehicles/vehicles.wxml`
- Modify: `pages/vehicles/vehicles.wxss`
- Modify: `pages/add/add.wxml`
- Modify: `pages/add/add.wxss`

- [ ] Update detail page to use a hero summary, fee/navigation card, and grouped info sections.
- [ ] Update vehicles page to use a clear page header, current vehicle summary, and scannable vehicle cards.
- [ ] Update add/edit page to use a step-like form flow while preserving current fields.
- [ ] Run `npm test` and `git diff --check`.
