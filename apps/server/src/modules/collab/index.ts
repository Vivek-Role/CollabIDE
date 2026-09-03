/**
 * The collaboration module's public surface. Cross-module imports go through
 * this barrel only.
 *
 * Module 3.4b adds the revocation and file-delete hooks here, which are what
 * projects/service.ts and files/service.ts will call.
 */

export { allRooms, flushAllRooms, joinRoom, leaveRoom, roomCount, type Room } from './room.js';
export {
  closeFileRooms,
  disconnectProject,
  disconnectProjectUser,
  handleConnection,
} from './syncHandler.js';
export { attachWsServer, type CollabConnection } from './wsServer.js';
