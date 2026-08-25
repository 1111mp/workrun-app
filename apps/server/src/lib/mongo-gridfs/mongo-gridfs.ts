import { tmpdir } from 'node:os';
import Stream from 'node:stream';

import {
  createReadStream,
  createWriteStream,
  pathExists,
  unlinkSync,
} from 'fs-extra';
import {
  Db,
  Document,
  GridFSBucket,
  GridFSBucketReadStream,
  GridFSFile,
  ObjectId,
} from 'mongodb';
import uniqueFilename from 'unique-filename';

export interface IGridFSObject {
  _id: ObjectId;
  length: number;
  chunkSize: number;
  uploadDate: Date;
  md5: string;
  filename: string;
  contentType: string;
  metadata: object;
}

export interface IGridFSWriteOption {
  filename: string;
  chunkSizeBytes?: number;
  metadata?: Document;
  contentType?: string;
  aliases?: string[];
}

export interface IDownloadOptions {
  filename: boolean | string;
  targetDir?: string;
}

export class MongoGridFS {
  /**
   * Constructor
   * @param {connection} connection
   * @param {string} bucketName
   */
  constructor(
    public readonly connection: Db,
    public readonly bucketName: string = 'fs',
  ) {}

  public get bucket(): GridFSBucket {
    return new GridFSBucket(this.connection, { bucketName: this.bucketName });
  }

  public static getDownloadPath(
    object: GridFSFile,
    options: IDownloadOptions = {
      filename: false,
    },
  ): string {
    let finalPath = '';
    if (!options.targetDir) {
      if (typeof options.filename === 'string') {
        finalPath = `${tmpdir()}/${options.filename}`;
      } else {
        if (options.filename === true) {
          finalPath = `${tmpdir()}/${object._id}`;
        } else {
          finalPath = uniqueFilename(tmpdir());
        }
      }
    } else {
      if (typeof options.filename === 'string') {
        finalPath = `${options.targetDir}/${options.filename}`;
      } else {
        if (options.filename === true) {
          finalPath = object.filename;
        } else {
          finalPath = uniqueFilename(options.targetDir);
        }
      }
    }
    return finalPath;
  }

  /**
   * Returns a stream of a file from the GridFS.
   * @param {string} id
   * @return {Promise<GridFSBucketReadStream>}
   */
  public async readFileStream(id: string): Promise<GridFSBucketReadStream> {
    const object = await this.findById(id);
    return this.bucket.openDownloadStream(object._id);
  }

  /**
   * Save the File from the GridFs to the filesystem and get the Path back
   * @param {string} id
   * @param {IDownloadOptions} options
   * @return {Promise<string>}
   */
  public async downloadFile(
    id: string,
    options?: IDownloadOptions,
  ): Promise<string> {
    const object = await this.findById(id);
    const downloadPath = MongoGridFS.getDownloadPath(object, options);
    return new Promise<string>((resolve, reject) => {
      this.bucket
        .openDownloadStream(object._id)
        .once('error', async (error) => {
          reject(error);
        })
        .once('end', async () => {
          resolve(downloadPath);
        })
        .pipe(createWriteStream(downloadPath, {}));
    });
  }

  /**
   * Find a single object by id
   * @param {string} id
   * @return {Promise<GridFSFile>}
   */
  public async findById(id: string): Promise<GridFSFile> {
    return this.findOne({ _id: new ObjectId(id) });
  }

  /**
   * Find a single object by condition
   * @param filter
   * @return {Promise<GridFSFile>}
   */
  public async findOne(filter: any): Promise<GridFSFile> {
    const result = await this.find(filter);
    if (result.length === 0) {
      throw new Error('No Object found');
    }
    return result[0];
  }

  /**
   * Find a list of object by condition
   * @param filter
   * @return {Promise<GridFSFile[]>}
   */
  public async find(filter: any): Promise<GridFSFile[]> {
    return this.bucket.find(filter).toArray();
  }

  /**
   * Find objects by condition
   * @param stream
   * @param options
   */
  public writeFileStream(
    stream: Stream,
    options: IGridFSWriteOption,
  ): Promise<GridFSFile | null> {
    return new Promise((resolve, reject) => {
      const metadata = {
        ...options.metadata,
        ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
        ...(options.contentType === undefined
          ? {}
          : { contentType: options.contentType }),
      };
      const uploadStream = this.bucket.openUploadStream(options.filename, {
        chunkSizeBytes: options.chunkSizeBytes,
        metadata,
      });

      stream
        .pipe(uploadStream)
        .on('error', async (err) => {
          reject(err);
        })
        .on('finish', async () => {
          resolve(uploadStream.gridFSFile);
        });
    });
  }

  /**
   * Upload a file directly from a fs Path
   * @param {string} uploadFilePath
   * @param {IGridFSWriteOption} options
   * @param {boolean} deleteFile
   * @return {Promise<GridFSFile>}
   */
  public async uploadFile(
    uploadFilePath: string,
    options: IGridFSWriteOption,
    deleteFile: boolean = true,
  ): Promise<GridFSFile> {
    if (!(await pathExists(uploadFilePath))) {
      throw new Error('File not found');
    }
    const tryDeleteFile = async (obj?: any): Promise<any> => {
      if ((await pathExists(uploadFilePath)) && deleteFile === true) {
        unlinkSync(uploadFilePath);
      }
      return obj;
    };
    return await this.writeFileStream(createReadStream(uploadFilePath), options)
      .then(tryDeleteFile)
      .catch(async (err) => {
        await tryDeleteFile();
        throw err;
      });
  }

  /**
   * Delete an File from the GridFS
   * @param {string} id
   * @return {Promise<void>}
   */
  public async delete(id: string): Promise<void> {
    return this.bucket.delete(new ObjectId(id));
  }
}
