import { ConfigService } from '@nestjs/config';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActionTokenService } from 'src/action-token/action-token.service';
import { MailService } from 'src/mail/mail.service';
import { Patch, PatchOutput, PatchType } from './patch.model';
import { PatchesService } from './patches.service';
import { UploadPatchInput } from './upload-patch.input';
import { GraphQLUpload, FileUpload } from 'graphql-upload';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, unlink } from 'fs/promises';
import { createWriteStream, fstat, ReadStream } from 'fs';
import { exec } from 'child_process';
import * as imageThumbnail from "image-thumbnail";
import * as fs from "fs/promises";

const processFiles = async (
  files: Promise<FileUpload>[],
  storagePath: string,
) => {
  const outputFiles: { path: string; type: string; name: string }[] = [];

  for (const f of files) {
    const fileInfos = await f;
    let type: 'image' | 'sound' | 'bsk' | 'pfb' = null;
    switch (fileInfos.mimetype) {
      case 'image/jpeg':
      case 'image/png':
        type = 'image';
        break;
      case 'audio/mpeg3':
      case 'audio/mp3':
      case 'audio/mpeg':
        type = 'sound';
        break;
      default:
        if (fileInfos.filename.endsWith('.bsk')) {
          type = 'bsk';
        } else if (fileInfos.filename.endsWith('.pfb')) {
          type = 'pfb';
        } else {
          throw new Error('Unknown file type received');
        }
    }
    const path = await new Promise<string>((resolve, reject) => {
      const p = `${storagePath}/${fileInfos.filename}`;
      const stream: ReadStream = fileInfos.createReadStream();
      stream
        .pipe(createWriteStream(p))
        .on('finish', () => {
          return resolve(p);
        })
        .on('error', () => {
          return reject(false);
        });
    });

    outputFiles.push({ path, type, name: fileInfos.filename });
  }

  return outputFiles;
};

const bsFileJsonInfos = (path: string, pythonExec = 'python') => {
  return new Promise((resolve, reject) => {
    exec(
      `${pythonExec} ./scripts/create_manifest.py "${path}"`,
      (err, stdout) => {
        if (err != null) {
          reject(err);
        } else {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(e);
          }
        }
      },
    );
  });
};

const processImages = async (patch: Patch, imagePath: string, storageDir: string) => {
  
  try {
    const options = {
      width: 500, 
      height: 250,
      fit: "cover",
      jpegOptions : { 
        force:true, 
        quality: 80 
      }
    } as any;
    const data = await imageThumbnail(imagePath, options);
    fs.writeFile(`${storageDir}/thumb.jpg`, data);
    patch.thumbnailImage = "thumb.jpg";
  } catch(e) {
    console.warn(`Could not create thumbnail for ${patch.uuid}`, e);
  }

  try {
    const options = {
      width: 2000, 
      height: 1000,
      fit: "contain",
      jpegOptions : { 
        force: true,
        quality: 80 
      }
    } as any;
    const data = await imageThumbnail(imagePath, options);
    fs.writeFile(`${storageDir}/cover.jpg`, data);
    patch.coverImage = "cover.jpg";
  } catch(e) {
    console.warn(`Could not create cover for ${patch.uuid}`, e);
  }
}

const removeFilesIfExists = (patch: Patch) => {
  const remove = async (path: string | null) => {
    try {
      if (path != null && path.length > 0) {
        await unlink(patch.getPath(path));
      }
    } catch (e) {
      console.debug(e);
    }
  };

  remove(patch.bsFile);
  remove(patch.coverImage);
  (patch.audioSamples || []).map((as) => remove(as));
};
@Resolver()
export class PatchesResolver {
  constructor(
    private service: PatchesService,
    private actionTokenService: ActionTokenService,
    private mailService: MailService,
    private config: ConfigService,
  ) {}

  @Query(() => [String])
  async tags() {
    return this.service.getAllTags();
  }

  @Query(() => PatchOutput, {
    description: 'Retrieves a full patch',
  })
  async patch(
    @Args('uuid', { description: 'Patch identifier' }) uuid: string,
    @Args('token', { nullable: true })
    token: string | null,
  ) {
    return this.service.get(uuid, token);
  }

  @Mutation(() => Boolean, {
    description: 'Approve (make it visible) or revoke (delete) a patch ',
  })
  async moderatePatch(
    @Args('uuid') uuid: string,
    @Args('token', { nullable: true }) token: string | null,
    @Args('approved') approved: boolean,
  ) {
    const patch = await this.service.moderate(uuid, token, approved);

    if (!approved) {
      removeFilesIfExists(patch);
    }
    this.mailService.sendModerationResult(patch, approved);

    return approved;
  }

  @Query(() => [PatchOutput], {
    description: 'List patches (brief format) based on search input and tags',
  })
  async patches(
    @Args('tags', { defaultValue: [], type: () => [String] }) tags: string[],
    @Args('search', { defaultValue: null, type: () => String })
    search: string | null,
    @Args('offset', { defaultValue: 0, type: () => Int })
    offset: number,
    @Args('limit', { defaultValue: 20, type: () => Int })
    limit: number,
  ) {
    return this.service.find(tags, search, offset, limit);
  }

  @Mutation(() => String, {
    description:
      'Upload patch/prefab (type based on file extension) after getting an action token',
  })
  async uploadPatch(
    @Args('uploadInfo')
    uploadInfo: UploadPatchInput,
    @Args('tokenUuid')
    tokenUuid: string,
    @Args('files', { type: () => [GraphQLUpload] })
    files: Promise<FileUpload>[],
  ) {
    if (
      !this.config.get<boolean>('DISABLE_ACTION_TOKEN_CHECK') &&
      !(await this.actionTokenService.get(tokenUuid)).enabled
    ) {
      throw new Error('Token not enabled');
    }

    const patchToSave = new Patch();
    patchToSave.uuid = uuidv4();

    try {
      const storageDir = `${this.config.get('STORAGE_DIR')}/${
        patchToSave.uuid
      }`;
      await mkdir(storageDir);
      const processedFiles = await processFiles(files, storageDir);

      const [bskFile] = processedFiles.filter(({ type }) => type === 'bsk');
      const [pfbFile] = processedFiles.filter(({ type }) => type === 'pfb');
      const [imageFile] = processedFiles.filter(({ type }) => type === 'image');
      const sounds = processedFiles.filter(({ type }) => type === 'sound');

      if (bskFile == null && pfbFile == null) {
        throw new Error('No bsk file provided');
      }

      patchToSave.type = bskFile != null ? PatchType.PATCH : PatchType.PREFAB;
      const bsFile = bskFile || pfbFile;

      patchToSave.bsFile = bsFile.name;

      if (imageFile != null) {
        await processImages(patchToSave, imageFile.path, storageDir);
      }

      patchToSave.audioSamples = sounds.map((x) => x.name);

      const bsContent = await bsFileJsonInfos(
        bsFile.path,
        this.config.get('PYTHON_EXEC'),
      );
      patchToSave.content = JSON.stringify(bsContent);
    } catch (e) {
      removeFilesIfExists(patchToSave);
      console.error(e);
      throw new Error('An error happened while processing files');
    }

    let patch = null;

    try {
      patchToSave.title = uploadInfo.title;
      patchToSave.author = uploadInfo.author;
      patchToSave.mail = uploadInfo.mail;
      patchToSave.appVersion = uploadInfo.version;
      patchToSave.tags = [
        patchToSave.type,
        ...uploadInfo.tags.filter((t) => !['patch', 'prefab'].includes(t)),
      ];
      patchToSave.summary = uploadInfo.summary;
      patchToSave.description = uploadInfo.description;

      patch = await this.service.save(patchToSave);
    } catch (e) {
      removeFilesIfExists(patchToSave);
      console.error(e);
      throw new Error('Error while creating the patch');
    }

    if (!this.config.get<boolean>('DISABLE_ACTION_TOKEN_CHECK')) {
      await this.actionTokenService.deleteToken(tokenUuid);
    }
    await this.mailService.sendSubmittedPatch(patch);

    return patch.uuid;
  }
}
