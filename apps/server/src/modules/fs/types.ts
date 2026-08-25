import { Stream } from 'node:stream';

export interface FSMetaData {
  id: string;
  scope: string;
  filename: string;
  url?: string;
  contentType?: string;
  size?: number;
  extra:
    | {
        fileId?: string;
        md5?: string;
        mimetype?: string;
        referrer?: string;
        owner?: string;
        referrers?: string[];
      }
    | undefined;
}

export interface CommonFSService {
  getMetaData(scope: string, id: string): Promise<FSMetaData>;
  getMetaDataByName(scope: string, filename: string): Promise<FSMetaData>;

  read(id: string): Promise<Stream>;
  readByName(scope: string, filename: string): Promise<Stream>;

  write(
    scope: string,
    filename: string,
    content: string | Buffer | Stream,
    extra: FSMetaData['extra'],
  ): Promise<FSMetaData>;

  remove(scope: string, id: string, referrer?: string): Promise<void>;
  removeByName(
    scope: string,
    filename: string,
    referrer?: string,
  ): Promise<void>;
  removeFilesByScope(scope: string): Promise<void>;
}
